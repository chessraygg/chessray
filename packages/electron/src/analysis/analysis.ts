/**
 * Analysis renderer — thin bootstrap that owns a single `FrameProcessor`.
 * The heavy per-frame pipeline lives in `frame-processor.ts`. This file only
 * wires electron IPC, the YOLO session, and Stockfish into the class.
 */

import type { PixelBuffer } from '@chessray/core';
import type { PipelineResult } from '../shared/types.js';
import { setMultiPvMax, setMultiPvRamp } from './eval-cache.js';
import { getEngine, getRecognizer, getOnnxSession, getOrtModule, reinitEngine } from './engine-init.js';
import { initAndStartCapture, stopCapture, setTargetFps, type FrameMeta } from './frame-capture.js';
import { FrameProcessor, type ImageDataLike } from './frame-processor.js';
import { setRecording, recordFrame, recordResultSidecar, currentFrameFilename, isRecording } from './frame-recorder.js';

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

// Holds the filename of the most-recently saved PNG so we can pair the
// PipelineResult JSON sidecar with it. A closure not a module var because
// processFrame is async and multiple frames could overlap conceptually.
let pendingArtifactFilename: string | null = null;

const processor = new FrameProcessor({
  get onnxSession() { return getOnnxSession(); },
  get ortModule() { return getOrtModule(); },
  get recognizer() { return getRecognizer(); },
  getEngine,
  reinitEngine,
  sendResult: (r: PipelineResult) => {
    window.chessRay.sendFrameResult(r);
    if (isRecording() && pendingArtifactFilename) {
      recordResultSidecar(pendingArtifactFilename, r);
    }
  },
  log: debugLog,
  encodePreviewUrl,
});

async function onCapturedFrame(imageData: ImageDataLike, meta: FrameMeta): Promise<void> {
  if (isRecording()) {
    pendingArtifactFilename = currentFrameFilename();
    // Fire and forget — PNG encoding should not block the processor.
    void recordFrame(imageData);
  } else {
    pendingArtifactFilename = null;
  }
  await processor.processFrame(imageData, meta);
}

window.chessRay.onRecordingStateChanged((active: boolean, sessionDir: string | null) => {
  setRecording(active);
  debugLog(active ? `Recording started → ${sessionDir}` : 'Recording stopped');
});

window.chessRay.onStartCapture((sourceId) => {
  processor.resetFrameCount();
  initAndStartCapture(sourceId, onCapturedFrame, () => processor.resetCaches());
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
    initAndStartCapture(sourceId, onCapturedFrame, () => processor.resetCaches());
  }
});
