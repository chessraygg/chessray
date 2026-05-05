/**
 * Offscreen document: the long-lived worker for the extension.
 *
 * Owns a single FrameProcessor instance from @chessray/runtime — the same
 * pipeline class the Electron app uses. Host-specific bits (Stockfish/YOLO
 * init, tab-capture stream lifecycle, chrome.tabs message routing) stay
 * here; the per-frame state machine, eval cache, change detection,
 * iterative deepening, and intermediate-frame handling all come from the
 * shared runtime.
 */

import './vendor.ts';
// Default `onnxruntime-web` resolves to ort.bundle.min.mjs (WASM only).
// /webgpu picks ort.webgpu.bundle.min.mjs which keeps WASM for non-GPU ops
// while exposing the WebGPU EP that core's YoloPieceRecognizer requests.
import * as ort from 'onnxruntime-web/webgpu';
import { StockfishEngine, YoloPieceRecognizer, type PixelBuffer, type PipelineResult } from '@chessray/core';
import { FrameProcessor, type ImageDataLike, type FrameMeta } from '@chessray/runtime';
import type { ExtensionMessage } from '../shared/messages.js';

const TARGET_FPS = 2;

// ── ORT global wire-up ──
// Core's YoloPieceRecognizer reads `globalThis.ort` because the Electron host
// historically loaded ORT via a script tag. Mirror that contract here so the
// shared core code is unchanged.
(globalThis as typeof globalThis & { ort: typeof ort }).ort = ort;
ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/onnxruntime-web/');
ort.env.logLevel = 'warning';

let engine: StockfishEngine | null = null;
let recognizer: YoloPieceRecognizer | null = null;
let captureInterval: ReturnType<typeof setInterval> | null = null;
let mediaStream: MediaStream | null = null;
let videoEl: HTMLVideoElement | null = null;
let activeTabId: number | null = null;
let processing = false;
let previewCanvas: HTMLCanvasElement | null = null;
let previewCtx: CanvasRenderingContext2D | null = null;

function debugLog(msg: string): void {
  console.log(`[chessray] ${msg}`);
  // Forward to SW so it appears in the side panel's trace tail without
  // needing the offscreen DevTools console open.
  chrome.runtime.sendMessage({ type: 'log-from-offscreen', message: msg } satisfies ExtensionMessage)
    .catch(() => { /* SW asleep or no listener */ });
}

// ── Engine-info cache + push ──
// Offscreen owns the source of truth (it created the session, loaded
// the recognizer, called applyConstraints). The side panel reads it
// two ways: by querying 'get-engine-info' on mount and by listening
// for 'engine-info-update' broadcasts. We tried chrome.storage.session
// first but cross-context propagation between offscreen and the side
// panel was inconsistent — direct messaging is reliable.
type EngineInfoPatch = Partial<{
  yolo: string;
  stream: string;
  constraints: string;
}>;
const engineInfo: EngineInfoPatch = {};
function updateEngineInfo(patch: EngineInfoPatch): void {
  Object.assign(engineInfo, patch);
  // Broadcast — side panel listens for this and updates live without
  // polling. SW also receives it (no handler, ignored).
  chrome.runtime.sendMessage({ type: 'engine-info-update', info: { ...engineInfo } } satisfies ExtensionMessage)
    .catch(() => { /* no listeners (side panel closed) */ });
}

async function initEngine(): Promise<StockfishEngine> {
  if (engine) return engine;
  const sf = new StockfishEngine({});
  await sf.init(chrome.runtime.getURL('vendor/stockfish/stockfish-18-lite-single.js'));
  engine = sf;
  debugLog('Stockfish 18 initialized');
  return sf;
}

async function reinitEngine(): Promise<void> {
  debugLog('Reinitializing Stockfish after crash...');
  if (engine) {
    try { engine.destroy(); } catch { /* ignore */ }
  }
  engine = null;
  await initEngine();
}

async function initRecognizer(): Promise<YoloPieceRecognizer> {
  if (recognizer) return recognizer;
  const rec = new YoloPieceRecognizer(chrome.runtime.getURL('vendor/yolo-chess/chess-pieces.onnx'));
  await rec.load();
  recognizer = rec;
  // Surface the actual EP into the SW trace — 'wasm' here means GPU
  // accel didn't kick in and inference will be ~10-20× slower than it
  // could be. With WebGPU a YOLOv11n inference at 640×640 is ~30-50ms;
  // on WASM it's ~500-900ms (consistent with the user-reported timing).
  const yoloLine = `YOLO loaded, EP=${rec.executionProvider}, navigator.gpu=${!!(navigator as any).gpu}`;
  debugLog(yoloLine);
  updateEngineInfo({ yolo: yoloLine });
  return rec;
}

function encodePreviewUrl(cropped: PixelBuffer): string {
  if (!previewCanvas) {
    previewCanvas = document.createElement('canvas');
    previewCtx = previewCanvas.getContext('2d')!;
  }
  if (previewCanvas.width !== cropped.width || previewCanvas.height !== cropped.height) {
    previewCanvas.width = cropped.width;
    previewCanvas.height = cropped.height;
  }
  const imgData = new ImageData(
    cropped.data as unknown as Uint8ClampedArray<ArrayBuffer>,
    cropped.width,
    cropped.height,
  );
  previewCtx!.putImageData(imgData, 0, 0);
  return previewCanvas.toDataURL('image/jpeg', 0.7);
}

/** Visible to the test harness via the test-process-frame summary. */
const recentSendErrors: string[] = [];

async function pushResult(result: PipelineResult): Promise<void> {
  if (activeTabId === null) return;
  // chrome.tabs is unavailable inside offscreen documents — Chrome scopes
  // the API surface tightly. Hop through the service worker, which has
  // chrome.tabs and forwards to the content-script tab.
  const msg: ExtensionMessage = { type: 'forward-frame-result', tabId: activeTabId, result };
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (err) {
    const s = String(err);
    if (recentSendErrors.length < 5) recentSendErrors.push(s);
  }
}

const processor = new FrameProcessor({
  get onnxSession() { return recognizer?.session ?? null; },
  ortModule: ort,
  get recognizer() { return recognizer; },
  getEngine: () => engine,
  reinitEngine,
  sendResult: pushResult,
  log: debugLog,
  encodePreviewUrl,
});

async function startLoop(streamId: string, tabId: number, viewport?: { width: number; height: number }): Promise<void> {
  // Tear down any previous capture state — otherwise getUserMedia for the
  // new streamId can leak a second video track and the next stop won't
  // reach the original one.
  stopLoop();
  activeTabId = tabId;
  await Promise.all([initEngine(), initRecognizer()]);

  // Pin min=max to the tab's content area in physical pixels. Without this
  // Chrome applies a default size cap and produces a letterboxed frame
  // whose aspect ratio doesn't match the viewport — the bbox→CSS mapping
  // then carries a ~10-50 px error per axis. With min=max the captured
  // frame is the viewport scaled by DPR exactly, so frame coords ÷ DPR =
  // CSS coords. Trade-off: window resize after start invalidates this and
  // alignment drifts until the user restarts capture (acceptable per spec).
  const mandatory: Record<string, unknown> = {
    chromeMediaSource: 'tab',
    chromeMediaSourceId: streamId,
  };
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    mandatory.minWidth = viewport.width;
    mandatory.maxWidth = viewport.width;
    mandatory.minHeight = viewport.height;
    mandatory.maxHeight = viewport.height;
    debugLog(`getUserMedia pinned to ${viewport.width}x${viewport.height}`);
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // @ts-expect-error Chrome-specific mandatory constraints for tab capture
      mandatory,
    },
  });
  mediaStream = stream;
  // Log what Chrome actually allocated so we can see if the pinned
  // constraints took effect. If actual ≠ pinned, Chrome silently
  // ignored the constraints and the bbox→CSS mapping will misalign
  // in proportion to the discrepancy.
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings();
  const streamLine = `stream settings: ${settings?.width}x${settings?.height} (asked ${viewport?.width ?? '?'}x${viewport?.height ?? '?'})`;
  debugLog(streamLine);
  updateEngineInfo({ stream: streamLine });

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.addEventListener('loadedmetadata', () => {
    debugLog(`video loadedmetadata: ${video.videoWidth}x${video.videoHeight}`);
  });
  await video.play();
  videoEl = video;

  const canvas = document.getElementById('capture-canvas') as HTMLCanvasElement;
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  processor.resetFrameCount();

  captureInterval = setInterval(async () => {
    if (processing || !videoEl) return;
    if (videoEl.videoWidth > 0 && (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight)) {
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      processor.resetCaches();
    }
    processing = true;
    const tCap = Date.now();
    try {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height) as ImageDataLike;
      const captured_at = Date.now();
      const meta: FrameMeta = { capture_ms: captured_at - tCap, captured_at };
      await processor.processFrame(imageData, meta);
    } catch (err) {
      console.error('[chessray] frame processing error', err);
    } finally {
      processing = false;
    }
  }, 1000 / TARGET_FPS);
}

function stopLoop(): void {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
    videoEl.remove();
    videoEl = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  activeTabId = null;
  processor.resetPipelineState();
}

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg.type === 'get-engine-info') {
    sendResponse({ info: { ...engineInfo } });
    return false;
  }
  if (msg.type === 'capture-started') {
    // tabId is supplied by the service worker (offscreen has no chrome.tabs).
    startLoop(msg.streamId, msg.tabId, msg.viewport).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }
  if (msg.type === 'stop-capture') {
    stopLoop();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'test-process-frame') {
    activeTabId = msg.tabId;
    (async () => {
      await Promise.all([initEngine(), initRecognizer()]);
      const img = new Image();
      img.src = msg.dataUrl;
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = (e) => rej(e); });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, c.width, c.height) as ImageDataLike;
      processor.resetFrameCount();
      processor.resetCaches();
      // Capture every result emitted during this single processFrame so the
      // harness can inspect detection/recognition/eval without depending on
      // the content-script roundtrip (whose console isn't reliably visible
      // via puppeteer's targetcreated for offscreen docs).
      const captured: PipelineResult[] = [];
      const orig = processor['deps'].sendResult.bind(processor['deps']);
      (processor as unknown as { deps: { sendResult: typeof orig } }).deps.sendResult = (r) => {
        captured.push(r);
        orig(r);
      };
      try {
        await processor.processFrame(imageData, { capture_ms: 0, captured_at: Date.now() });
        // Wait briefly for async eval depths to settle.
        await new Promise(r => setTimeout(r, 4000));
      } finally {
        (processor as unknown as { deps: { sendResult: typeof orig } }).deps.sendResult = orig;
        // Stop iterative deepening so its frame-result broadcasts don't
        // keep flooding open extension surfaces (popup / side panel) after
        // we've returned from the test handler.
        const ac = (processor as unknown as { evalAbortController: AbortController | null }).evalAbortController;
        ac?.abort();
      }
      const last = captured[captured.length - 1];
      const summary = {
        results: captured.length,
        imageDims: `${c.width}x${c.height}`,
        boardFound: last?.board_detection?.found ?? false,
        bbox: last?.board_detection?.bbox ?? null,
        confidence: last?.board_detection?.confidence ?? 0,
        fen: last?.recognition?.fen ?? null,
        topMove: last?.evaluation?.top_moves?.[0]?.move ?? null,
        evalDepth: last?.eval_depth ?? null,
        arrows: last?.arrows?.length ?? 0,
        sendErrors: [...recentSendErrors],
      };
      recentSendErrors.length = 0;
      return summary;
    })().then((s) => sendResponse({ ok: true, summary: s }), (err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === 'viewport-resized') {
    // Resize the existing MediaStreamTrack via applyConstraints — we
    // CANNOT call chrome.tabCapture.getMediaStreamId here (no user
    // gesture). 'ideal' instead of 'exact' so Chrome doesn't reject if
    // it can't deliver the precise dimensions; the safety-net
    // center-crop in canvas-renderer handles any residual mismatch.
    if (!mediaStream) { sendResponse({ ok: false, error: 'no stream' }); return false; }
    const track = mediaStream.getVideoTracks()[0];
    if (!track) { sendResponse({ ok: false, error: 'no video track' }); return false; }
    const before = track.getSettings();
    debugLog(`viewport-resized: track was ${before.width}x${before.height}, asked ${msg.viewport.width}x${msg.viewport.height}`);
    track.applyConstraints({
      width: { ideal: msg.viewport.width },
      height: { ideal: msg.viewport.height },
    }).then(() => {
      const after = track.getSettings();
      const acLine = `applyConstraints ok: track now ${after.width}x${after.height}`;
      debugLog(acLine);
      updateEngineInfo({ constraints: acLine });
      // Force-resize the canvas now too — videoEl.videoWidth may take
      // a frame to update, so the next captureInterval tick already
      // sees the new size and processFrame uses it.
      if (videoEl && after.width && after.height) {
        const c = document.getElementById('capture-canvas') as HTMLCanvasElement;
        if (c.width !== after.width || c.height !== after.height) {
          c.width = after.width;
          c.height = after.height;
          processor.resetCaches();
        }
      }
      sendResponse({ ok: true });
    }).catch((err) => {
      debugLog(`applyConstraints FAILED: ${String(err)}`);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  if (msg.type === 'pause-capture') {
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
      debugLog('capture paused (PV animation)');
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'resume-capture') {
    // Only restart if we have an active stream and the loop isn't already
    // running. The original interval is owned by startLoop — re-create it
    // here using the same drawImage/processFrame pattern.
    if (mediaStream && videoEl && !captureInterval) {
      const canvas = document.getElementById('capture-canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      captureInterval = setInterval(async () => {
        if (processing || !videoEl) return;
        if (videoEl.videoWidth > 0 && (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight)) {
          canvas.width = videoEl.videoWidth;
          canvas.height = videoEl.videoHeight;
          processor.resetCaches();
        }
        processing = true;
        const tCap = Date.now();
        try {
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height) as ImageDataLike;
          const captured_at = Date.now();
          const meta: FrameMeta = { capture_ms: captured_at - tCap, captured_at };
          await processor.processFrame(imageData, meta);
        } catch (err) {
          console.error('[chessray] frame processing error', err);
        } finally {
          processing = false;
        }
      }, 1000 / TARGET_FPS);
      debugLog('capture resumed');
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'apply-setting') {
    const s = msg.setting;
    if (s.key === 'multi-pv-max') processor.setMultiPvMax(s.value);
    else if (s.key === 'manual-flip') processor.setManualFlip(s.value);
    // 'target-fps' would resize the capture loop; out of scope for the
    // initial extension parity pass — the loop runs at TARGET_FPS.
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
