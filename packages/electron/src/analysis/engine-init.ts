import { StockfishEngine, YoloPieceRecognizer } from '@chessray/core';
import { EVAL_START_DEPTH } from './eval-cache.js';

let engine: StockfishEngine | null = null;
let recognizer: YoloPieceRecognizer | null = null;
let onnxSession: any = null;
let ortModule: any = null;

let engineInitPromise: Promise<void> | null = null;
let recognizerInitPromise: Promise<void> | null = null;

export function getEngine(): StockfishEngine | null { return engine; }
export function getRecognizer(): YoloPieceRecognizer | null { return recognizer; }
export function getOnnxSession(): any { return onnxSession; }
export function getOrtModule(): any { return ortModule; }

function debugLog(msg: string): void {
  console.log(`[chessray] ${msg}`);
  window.chessRay.sendDebugLog(msg);
}

export async function initEngine(): Promise<void> {
  if (!engineInitPromise) {
    engineInitPromise = (async () => {
      engine = new StockfishEngine({ depth: EVAL_START_DEPTH, multiPV: 5 });
      const sfUrl = 'chess-vendor://stockfish/stockfish-18-lite-single.js';
      await engine.init(sfUrl);
      debugLog('Stockfish 18 initialized');
    })();
  }
  return engineInitPromise;
}

export async function reinitEngine(): Promise<void> {
  debugLog('Reinitializing Stockfish after crash...');
  if (engine) {
    try { engine.destroy(); } catch { /* ignore */ }
  }
  engine = null;
  engineInitPromise = null;
  await initEngine();
}

async function loadOrt(): Promise<void> {
  if ((globalThis as any).ort) return;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'chess-vendor://onnxruntime-web/ort.webgpu.min.js';
    script.onload = () => resolve();
    script.onerror = (e) => reject(new Error(`Failed to load ort.js: ${e}`));
    document.head.appendChild(script);
  });
}

export async function initRecognizer(): Promise<void> {
  if (!recognizerInitPromise) {
    recognizerInitPromise = (async () => {
      await loadOrt();
      ortModule = (globalThis as any).ort;
      if (!ortModule) throw new Error('ort global not found — ort.js failed to load');
      ortModule.env.wasm.wasmPaths = 'chess-vendor://onnxruntime-web/';
      ortModule.env.logLevel = 'warning';

      const gpuApi = (globalThis as any).navigator?.gpu;
      if (gpuApi) {
        try {
          const adapter = await gpuApi.requestAdapter();
          const device = adapter ? await adapter.requestDevice() : null;
          debugLog(`WebGPU test: adapter=${!!adapter} device=${!!device}`);
        } catch (e) {
          debugLog(`WebGPU test FAILED: ${e}`);
        }
      } else {
        debugLog('WebGPU: navigator.gpu not available');
      }
      const modelUrl = 'chess-vendor://yolo-chess/chess-pieces.onnx';
      const rec = new YoloPieceRecognizer(modelUrl);
      await rec.load();
      recognizer = rec;
      onnxSession = (rec as any).session;
      debugLog(`YOLO recognizer loaded | session EP: ${JSON.stringify(onnxSession?.handler?.backendHint ?? 'unknown')}`);
    })();
  }
  return recognizerInitPromise;
}
