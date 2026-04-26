/**
 * Offscreen document: the long-lived worker for the extension.
 *
 * Runs the detection pipeline + Stockfish + YOLO. Receives a tab-capture
 * stream id from the service worker, pulls video frames from it, and pushes
 * pipeline results back to the content script via
 * `chrome.tabs.sendMessage` (proxied through the service worker since
 * offscreen docs can't address tabs directly).
 *
 * Intentionally minimal vs. the electron FrameProcessor — this is a
 * scaffold that proves the architecture. Change detection, intermediate-frame
 * handling, iterative deepening, and the eval cache can be ported from
 * `packages/electron/src/analysis/frame-processor.ts` incrementally.
 */

import './vendor.ts';
// Default `onnxruntime-web` resolves to ort.bundle.min.mjs (WASM only).
// The /webgpu subpath gives us ort.webgpu.bundle.min.mjs, which keeps the
// WASM EP for non-GPU ops while exposing the WebGPU EP that core's YOLO
// recognizer requests first. Without this, every Chrome session silently
// falls back to WASM and inference is ~10× slower.
import * as ort from 'onnxruntime-web/webgpu';
import {
  StockfishEngine,
  YoloPieceRecognizer,
  detectBoard,
  cropPixels,
  recognizeBoard,
  buildFullFen,
  guessTurn,
  type EvalResult,
  type PixelBuffer,
} from '@chessray/core';
import { Chess } from 'chess.js';
import type { ExtensionMessage, ExtensionFrameResult } from '../shared/messages.js';

const TARGET_FPS = 2;
const MAX_DEPTH = 18;
const MULTI_PV = 3;

// ── ONNX Runtime global wire-up ──
// Core code (YoloPieceRecognizer, label-detect) reads `globalThis.ort`.
// The electron host historically injected `ort` via a script tag; in MV3
// we import the npm package and expose the same global so core is unchanged.
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

async function initEngine(): Promise<StockfishEngine> {
  if (engine) return engine;
  const sf = new StockfishEngine({ depth: MAX_DEPTH, multiPV: MULTI_PV });
  await sf.init(chrome.runtime.getURL('vendor/stockfish/stockfish-18-lite-single.js'));
  engine = sf;
  return sf;
}

async function initRecognizer(): Promise<YoloPieceRecognizer> {
  if (recognizer) return recognizer;
  const rec = new YoloPieceRecognizer(chrome.runtime.getURL('vendor/yolo-chess/chess-pieces.onnx'));
  await rec.load();
  recognizer = rec;
  return rec;
}

/** Load the shared board-detection ONNX session (same YOLO model as pieces —
 *  the core pipeline uses the recognizer's session for board detection too). */
function getBoardDetectSession(): unknown {
  return recognizer?.session ?? null;
}

async function pushResult(result: ExtensionFrameResult): Promise<void> {
  if (activeTabId === null) return;
  const msg: ExtensionMessage = { type: 'frame-result', result };
  await chrome.tabs.sendMessage(activeTabId, msg).catch(() => {
    // Content script may not be ready yet on the first few frames.
  });
}

async function processFrame(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<void> {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels: PixelBuffer = {
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  };

  const detection = await detectBoard(getBoardDetectSession(), ort, pixels.data, pixels.width, pixels.height);
  if (!detection.bbox) {
    await pushResult({ bbox: null, fen: null, evaluation: null, arrows: [], flipped: false, status: 'No board' });
    return;
  }

  const cropped = cropPixels(pixels, detection.bbox);
  const board = await recognizeBoard(cropped, recognizer!, null, null);
  if (!board.recognition || board.recognition.confidence < 0.3) {
    await pushResult({
      bbox: detection.bbox,
      fen: null,
      evaluation: null,
      arrows: [],
      flipped: board.flipped,
      status: 'Low confidence',
    });
    return;
  }

  const turn = board.turn ?? guessTurn(null, board.recognition.fen);
  const fullFen = buildFullFen(board.recognition.fen, turn);

  let gameOverStatus: string | undefined;
  try {
    const chess = new Chess(fullFen);
    if (chess.isCheckmate()) gameOverStatus = 'checkmate';
    else if (chess.isStalemate()) gameOverStatus = 'stalemate';
  } catch {
    // Invalid FEN — let the engine call fail naturally below.
  }

  if (gameOverStatus) {
    await pushResult({
      bbox: detection.bbox,
      fen: fullFen,
      evaluation: null,
      arrows: [],
      flipped: board.flipped,
      status: gameOverStatus,
    });
    return;
  }

  const sf = await initEngine();
  const evalResult: EvalResult = await sf.evaluate(fullFen, { depth: MAX_DEPTH, multiPV: MULTI_PV });
  const arrows = evalResult.top_moves.slice(0, 3).map((m, i) => ({
    from: m.move.slice(0, 2),
    to: m.move.slice(2, 4),
    color: i === 0 ? '#00c853' : i === 1 ? '#ffd600' : '#ff9100',
    width: 8,
    opacity: i === 0 ? 0.9 : 0.6,
  }));

  await pushResult({
    bbox: detection.bbox,
    fen: fullFen,
    evaluation: evalResult,
    arrows,
    flipped: board.flipped,
  });
}

async function startLoop(streamId: string, tabId: number): Promise<void> {
  activeTabId = tabId;
  await Promise.all([initEngine(), initRecognizer()]);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // Chrome tab-capture constraints — not in lib.dom, hence the ts-expect-error.
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

  captureInterval = setInterval(async () => {
    if (processing || !videoEl) return;
    if (videoEl.videoWidth > 0 && (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight)) {
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
    }
    processing = true;
    try {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      await processFrame(canvas, ctx);
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
}

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg.type === 'capture-started') {
    // The service worker has already determined the active tab id via
    // chrome.tabs.query; it's encoded in the streamId-originating tab. We
    // ask chrome for the currently active tab here since offscreen docs
    // can't otherwise discover it.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      startLoop(msg.streamId, tabId).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
    });
    return true;
  }
  if (msg.type === 'stop-capture') {
    stopLoop();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
