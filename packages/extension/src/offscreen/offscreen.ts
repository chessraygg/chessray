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

async function startLoop(streamId: string, tabId: number): Promise<void> {
  // Tear down any previous capture state — otherwise getUserMedia for the
  // new streamId can leak a second video track and the next stop won't
  // reach the original one.
  stopLoop();
  activeTabId = tabId;
  await Promise.all([initEngine(), initRecognizer()]);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // @ts-expect-error Chrome-specific mandatory constraints for tab capture
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });
  mediaStream = stream;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
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
  if (msg.type === 'capture-started') {
    // tabId is supplied by the service worker (offscreen has no chrome.tabs).
    startLoop(msg.streamId, msg.tabId).then(
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
  if (msg.type === 'apply-setting') {
    const s = msg.setting;
    if (s.key === 'multi-pv-max') processor.setMultiPvMax(s.value);
    else if (s.key === 'change-detect') processor.setChangeDetect(s.value);
    else if (s.key === 'manual-flip') processor.setManualFlip(s.value);
    // 'target-fps' would resize the capture loop; out of scope for the
    // initial extension parity pass — the loop runs at TARGET_FPS.
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
