/**
 * Analysis renderer — thin bootstrap that owns a single `FrameProcessor`.
 * The heavy per-frame pipeline lives in `frame-processor.ts`. This file only
 * wires electron IPC, the YOLO session, and Stockfish into the class.
 */

import type { PixelBuffer } from '@chessray/core';
import { setMultiPvMax, setMultiPvRamp } from './eval-cache.js';
import { getEngine, getRecognizer, getOnnxSession, getOrtModule, reinitEngine } from './engine-init.js';
import { initAndStartCapture, stopCapture, setTargetFps } from './frame-capture.js';
import { FrameProcessor } from './frame-processor.js';

/// <reference path="../shared/window.d.ts" />

function debugLog(msg: string): void {
  console.log(`[chessray] ${msg}`);
  window.chessRay.sendDebugLog(msg);
}

// Canvas used to encode the cropped board preview as a JPEG data URL.
// The preview is shown in the overlay debug panel; kept off the FrameProcessor
// so the class can run in Node (tests) with no DOM.
let previewCanvas: HTMLCanvasElement | null = null;
let previewCtx: CanvasRenderingContext2D | null = null;

function encodePreviewUrl(cropped: PixelBuffer): string {
  if (!previewCanvas) {
    previewCanvas = document.createElement('canvas');
    previewCtx = previewCanvas.getContext('2d')!;
  }
  if (previewCanvas.width !== cropped.width || previewCanvas.height !== cropped.height) {
    previewCanvas.width = cropped.width;
    previewCanvas.height = cropped.height;
  }
  const imgData = new ImageData(cropped.data as unknown as Uint8ClampedArray<ArrayBuffer>, cropped.width, cropped.height);
  previewCtx!.putImageData(imgData, 0, 0);
  return previewCanvas.toDataURL('image/jpeg', 0.7);
}

const processor = new FrameProcessor({
  get onnxSession() { return getOnnxSession(); },
  get ortModule() { return getOrtModule(); },
  get recognizer() { return getRecognizer(); },
  getEngine,
  reinitEngine,
  sendResult: (r) => window.chessRay.sendFrameResult(r),
  log: debugLog,
  encodePreviewUrl,
});

window.chessRay.onStartCapture((sourceId) => {
  processor.resetFrameCount();
  initAndStartCapture(sourceId, (imageData) => processor.processFrame(imageData), () => processor.resetCaches());
});

window.chessRay.onStopCapture(() => {
  stopCapture(() => processor.resetPipelineState());
  previewCanvas = null;
  previewCtx = null;
});

window.chessRay.onSetMaxDepth((depth: number) => {
  debugLog(`Max depth changed to ${depth}`);
  processor.setMaxDepth(depth);
});

window.chessRay.onSetMultiPvMax((n: number) => {
  debugLog(`MultiPV max changed to ${n}`);
  setMultiPvMax(n);
  processor.setMultiPvMax(n);
});

window.chessRay.onSetMultiPvRamp((n: number) => {
  debugLog(`MultiPV ramp changed to ${n} steps/line`);
  setMultiPvRamp(n);
  processor.setMultiPvRamp(n);
});

window.chessRay.onSetChangeDetect((enabled: boolean) => {
  debugLog(`Change detection ${enabled ? 'enabled' : 'disabled'}`);
  processor.setChangeDetect(enabled);
});

window.chessRay.onSetTargetFps((fps: number) => {
  debugLog(`Target FPS changed to ${fps}`);
  setTargetFps(fps);
});

window.chessRay.sendRendererReady();

window.chessRay.getSourceId().then((sourceId) => {
  if (sourceId) {
    debugLog(`Got pending source ID on startup: ${sourceId.slice(0, 30)}...`);
    processor.resetFrameCount();
    initAndStartCapture(sourceId, (imageData) => processor.processFrame(imageData), () => processor.resetCaches());
  }
});
