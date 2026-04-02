/**
 * Analysis renderer — the heavy computation hub (port of offscreen.ts).
 * Runs in a hidden BrowserWindow with full DOM/Web Worker access.
 *
 * Pipeline: capture frame → detect board (YOLO) → recognize pieces (YOLO) → evaluate → arrows
 */

import {
  StockfishEngine, detectBoard, YoloPieceRecognizer,
  cropPixels, recognizeBoard, turnFromHighlight,
  computeArrows, compareFen, guessTurn, buildFullFen,
} from '@chessray/core';
import type {
  PixelBuffer, PipelineResult, EvalResult, RecognitionResult, BoardBBox, ArrowDescriptor,
  OrientationSource,
} from '@chessray/core';

declare global {
  interface Window {
    chessRay: {
      onStartCapture: (cb: (sourceId: string) => void) => void;
      onStopCapture: (cb: () => void) => void;
      sendRendererReady: () => void;
      getSourceId: () => Promise<string | null>;
      sendFrameResult: (result: unknown) => void;
      sendDebugLog: (msg: string) => void;
      getSources: () => Promise<Array<{ id: string; name: string; thumbnailDataUrl: string; display_id: string }>>;
      selectSource: (id: string) => void;
    };
  }
}

const TARGET_FPS = 2;
const EVAL_START_DEPTH = 12;
const EVAL_DEPTH_STEP = 4;
const EVAL_MAX_DEPTH = 28;
const EVAL_CACHE_SIZE = 32;
const ENGINE_ID = 'stockfish-18-lite-single';

// LRU cache: engineId:fullFen → { eval, arrows } at highest depth seen
interface CachedEval { evaluation: EvalResult; arrows: ArrowDescriptor[] }
const evalCache = new Map<string, CachedEval>();

function cacheKey(fen: string): string {
  return `${ENGINE_ID}:${fen}`;
}

function cacheGet(fen: string): CachedEval | undefined {
  const key = cacheKey(fen);
  const entry = evalCache.get(key);
  if (entry) {
    evalCache.delete(key);
    evalCache.set(key, entry);
  }
  return entry;
}

function cachePut(fen: string, entry: CachedEval): void {
  const key = cacheKey(fen);
  evalCache.delete(key);
  evalCache.set(key, entry);
  if (evalCache.size > EVAL_CACHE_SIZE) {
    const oldest = evalCache.keys().next().value!;
    evalCache.delete(oldest);
  }
}

let mediaStream: MediaStream | null = null;
let captureInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;
let engine: StockfishEngine | null = null;
let recognizer: YoloPieceRecognizer | null = null;
let onnxSession: any = null;
let ortModule: any = null;
let videoElement: HTMLVideoElement | null = null;

let previewCanvas: HTMLCanvasElement | null = null;
let previewCtx: CanvasRenderingContext2D | null = null;

// Pipeline state
let lastPositionFen: string | null = null;
let prevPositionFen: string | null = null;
let lastEval: EvalResult | null = null;
let lastBoardSample: Uint8Array | null = null;
let lastRecognitionResult: RecognitionResult | null = null;
let lastRawFen: string = '';
let lastIsFlipped = false;
let lastOrientationSource: OrientationSource | undefined;
let lastHighlightedSquares: number[] = [];
let lastArrows: ArrowDescriptor[] = [];
let cachedBbox: BoardBBox | null = null;
let frameCount = 0;
let evalAbortController: AbortController | null = null;
let captureGeneration = 0; // monotonic counter to detect stale initAndStartCapture calls

/** Sample ~500 pixels from the board for quick visual change detection */
function sampleBoardPixels(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const sample = new Uint8Array(500 * 3);
  const step = Math.max(1, Math.floor(Math.sqrt(width * height / 500)));
  let idx = 0;
  for (let y = step; y < height && idx < 500 * 3; y += step) {
    for (let x = step; x < width && idx < 500 * 3; x += step) {
      const i = (y * width + x) * 4;
      sample[idx++] = data[i];
      sample[idx++] = data[i + 1];
      sample[idx++] = data[i + 2];
    }
  }
  return sample;
}

/** Compare two pixel samples; returns true if visually similar */
function boardUnchanged(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.min(a.length, b.length);
  const numPixels = Math.floor(len / 3);
  let changedPixels = 0;
  for (let i = 0; i < numPixels; i++) {
    const j = i * 3;
    if (Math.abs(a[j] - b[j]) > 30 || Math.abs(a[j+1] - b[j+1]) > 30 || Math.abs(a[j+2] - b[j+2]) > 30) {
      changedPixels++;
    }
  }
  return changedPixels / numPixels < 0.015;
}

function debugLog(msg: string): void {
  console.log(`[chessray] ${msg}`);
  window.chessRay.sendDebugLog(msg);
}

function sendResult(result: PipelineResult): void {
  window.chessRay.sendFrameResult(result);
}

// ── Capture pipeline ──

let engineInitPromise: Promise<void> | null = null;
async function initEngine(): Promise<void> {
  if (!engineInitPromise) {
    engineInitPromise = (async () => {
      engine = new StockfishEngine({ depth: EVAL_START_DEPTH, multiPV: 3 });
      const sfUrl = 'chess-vendor://stockfish/stockfish-18-lite-single.js';
      await engine.init(sfUrl);
      debugLog('Stockfish 18 initialized');
    })();
  }
  return engineInitPromise;
}

async function reinitEngine(): Promise<void> {
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

let recognizerInitPromise: Promise<void> | null = null;
async function initRecognizer(): Promise<void> {
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

async function initAndStartCapture(sourceId: string): Promise<void> {
  stopCapture();
  const myGeneration = ++captureGeneration;

  try {
    debugLog('Initializing engine + recognizer...');
    await Promise.all([initEngine(), initRecognizer()]);
    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture — a newer call superseded this one');
      return;
    }
    debugLog('Engine + recognizer ready');

    const gpuAvailable = !!(globalThis as any).navigator?.gpu;
    const ep = onnxSession?.handler?.backendHint ?? 'unknown';
    debugLog(`Backend: ONNX EP=${JSON.stringify(ep)}, WebGPU available=${gpuAvailable}, OpenCV=WASM`);

    // Get desktop capture stream using Electron's chromeMediaSource: 'desktop'
    debugLog(`Getting media stream for source: ${sourceId.slice(0, 30)}...`);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        // @ts-expect-error Electron-specific mandatory constraints for desktop capture
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
      audio: false,
    });
    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture — stopping acquired stream');
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    mediaStream = stream;
    debugLog(`MediaStream obtained: ${mediaStream.getVideoTracks().length} video tracks, active=${mediaStream.active}`);

    const videoTrack = mediaStream.getVideoTracks()[0];
    if (videoTrack) {
      const settings = videoTrack.getSettings();
      debugLog(`Video track: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
    }

    if (videoElement) {
      videoElement.pause();
      videoElement.srcObject = null;
      videoElement.remove();
    }

    const video = document.createElement('video');
    videoElement = video;
    video.srcObject = mediaStream;
    video.muted = true;
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    document.body.appendChild(video);

    const canvas = document.getElementById('capture-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    try {
      await video.play();
      debugLog(`video.play() succeeded, readyState=${video.readyState}, size=${video.videoWidth}x${video.videoHeight}`);
    } catch (err) {
      throw new Error(`video.play() failed: ${err}`);
    }

    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture after video.play()');
      video.pause();
      video.srcObject = null;
      video.remove();
      mediaStream?.getTracks().forEach(t => t.stop());
      return;
    }

    if (video.videoWidth === 0) {
      debugLog('Waiting for video dimensions...');
      await new Promise<void>((resolve) => {
        const onResize = () => {
          if (video.videoWidth > 0) {
            video.removeEventListener('resize', onResize);
            resolve();
          }
        };
        video.addEventListener('resize', onResize);
        video.addEventListener('loadedmetadata', () => {
          if (video.videoWidth > 0) resolve();
        });
        setTimeout(resolve, 5000);
      });
      debugLog(`After wait: size=${video.videoWidth}x${video.videoHeight}, readyState=${video.readyState}`);
    }

    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture after dimension wait');
      video.pause();
      video.srcObject = null;
      video.remove();
      mediaStream?.getTracks().forEach(t => t.stop());
      return;
    }

    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;

    // Wait for first non-black frame
    let gotRealFrame = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const sample = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      if (sample[0] + sample[1] + sample[2] > 0) {
        gotRealFrame = true;
        debugLog(`Non-black frame at attempt ${attempt}, pixel=[${sample[0]},${sample[1]},${sample[2]}]`);
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }

    if (!gotRealFrame) {
      debugLog('WARNING: All frames are black after 5s — starting capture anyway');
    }

    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture after frame wait');
      video.pause();
      video.srcObject = null;
      video.remove();
      mediaStream?.getTracks().forEach(t => t.stop());
      return;
    }

    debugLog(`Starting frame capture at ${TARGET_FPS}fps, canvas=${canvas.width}x${canvas.height}`);
    frameCount = 0;

    captureInterval = setInterval(() => {
      if (isProcessing) return;
      if (video.videoWidth > 0 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        cachedBbox = null;
        lastBoardSample = null;
      }
      isProcessing = true;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      processFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
    }, 1000 / TARGET_FPS);

  } catch (err) {
    debugLog(`Init/capture FAILED: ${err}`);
    throw err;
  }
}

async function processFrame(imageData: ImageData): Promise<void> {
  const startTime = Date.now();

  try {
    const pixels: PixelBuffer = {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    };

    let activeBbox = cachedBbox;
    let detectionConf = 1;
    let tDetect = 0;
    {
      const t0 = Date.now();
      // No panel exclusion needed — overlay is a separate window, not captured
      const detection = await detectBoard(onnxSession, ortModule, pixels.data, pixels.width, pixels.height);
      activeBbox = detection.bbox;
      detectionConf = detection.confidence;
      if (detection.bbox) cachedBbox = detection.bbox;
      tDetect = Date.now() - t0;
      if (frameCount < 10) {
        const bb = detection.bbox ? `bbox=${detection.bbox.x},${detection.bbox.y},${detection.bbox.width}x${detection.bbox.height}` : 'no bbox';
        debugLog(`Frame ${frameCount}: ${pixels.width}x${pixels.height} | ${bb} | found=${detection.found} conf=${detectionConf.toFixed(2)} time=${detection.elapsed_ms}ms`);
      }
    }
    frameCount++;

    if (!activeBbox) {
      sendResult({
        board_detection: { found: false, bbox: null, confidence: 0 },
        recognition: null,
        evaluation: null,
        arrows: [],
        total_elapsed_ms: Date.now() - startTime,
      });
      return;
    }

    let t = Date.now();
    const cropped = cropPixels(pixels, activeBbox);
    if (!previewCanvas) {
      previewCanvas = document.createElement('canvas');
      previewCtx = previewCanvas.getContext('2d')!;
    }
    if (previewCanvas.width !== cropped.width || previewCanvas.height !== cropped.height) {
      previewCanvas.width = cropped.width;
      previewCanvas.height = cropped.height;
    }
    const previewImgData = new ImageData(cropped.data as unknown as Uint8ClampedArray<ArrayBuffer>, cropped.width, cropped.height);
    previewCtx!.putImageData(previewImgData, 0, 0);
    const boardImageUrl = previewCanvas.toDataURL('image/jpeg', 0.7);
    const tPreview = Date.now() - t;

    const boardSample = sampleBoardPixels(cropped.data, cropped.width, cropped.height);
    const visuallyUnchanged = lastBoardSample && boardUnchanged(lastBoardSample, boardSample);
    lastBoardSample = boardSample;

    let recognition: RecognitionResult | null = null;
    let isFlipped = false;
    let orientationSource: OrientationSource | undefined;
    let rawFen = '';
    let highlightedSquares: number[] = [];
    let tRecog = 0;

    if (visuallyUnchanged && lastRecognitionResult) {
      recognition = lastRecognitionResult;
      rawFen = lastRawFen;
      isFlipped = lastIsFlipped;
      orientationSource = lastOrientationSource;
      highlightedSquares = lastHighlightedSquares;
    } else {
      t = Date.now();
      if (recognizer) {
        const boardResult = await recognizeBoard(cropped, recognizer);
        recognition = boardResult.recognition;
        rawFen = boardResult.rawFen;
        isFlipped = boardResult.flipped;
        orientationSource = boardResult.orientationSource;
        highlightedSquares = boardResult.highlightedSquares;
        if (frameCount <= 3) {
          debugLog(`Recognition: rawFen=${rawFen} conf=${recognition.confidence.toFixed(2)}`);
        }
      }
      tRecog = Date.now() - t;

      lastRecognitionResult = recognition;
      lastRawFen = rawFen;
      lastIsFlipped = isFlipped;
      lastOrientationSource = orientationSource;
      lastHighlightedSquares = highlightedSquares;

    }

    const makeResult = (opts: { evaluation?: EvalResult | null; arrows?: ArrowDescriptor[]; eval_depth?: number; eval_max_depth?: number }): PipelineResult => ({
      board_detection: { found: true, bbox: activeBbox!, confidence: detectionConf },
      recognition,
      evaluation: opts.evaluation ?? null,
      eval_depth: opts.eval_depth,
      eval_max_depth: opts.eval_max_depth,
      arrows: opts.arrows ?? [],
      highlighted_squares: highlightedSquares,
      flipped: isFlipped,
      orientation_source: orientationSource,
      board_image_url: boardImageUrl,
      frame_dimensions: { width: pixels.width, height: pixels.height },
      total_elapsed_ms: Date.now() - startTime,
    });

    const recogDetail = recognition?.timing
      ? `recog=${tRecog}ms(prep=${recognition.timing.prep_ms} infer=${recognition.timing.infer_ms} post=${recognition.timing.post_ms})`
      : `recog=${tRecog}ms`;

    if (!recognition || recognition.confidence < 0.3) {
      debugLog(`Timing: detect=${tDetect}ms preview=${tPreview}ms ${recogDetail} [low conf] total=${Date.now() - startTime}ms`);
      sendResult(makeResult({}));
      return;
    }

    const positionFen = recognition.fen;
    if (lastPositionFen && compareFen(lastPositionFen, positionFen)) {
      debugLog(`Timing: detect=${tDetect}ms preview=${tPreview}ms ${recogDetail} [dedup] total=${Date.now() - startTime}ms`);
      sendResult(makeResult({
        evaluation: lastEval,
        arrows: lastArrows,
        eval_depth: lastEval?.depth,
        eval_max_depth: lastEval && lastEval.depth < EVAL_MAX_DEPTH ? EVAL_MAX_DEPTH : undefined,
      }));
      return;
    }

    const whiteKings = (positionFen.match(/K/g) || []).length;
    const blackKings = (positionFen.match(/k/g) || []).length;
    if (whiteKings !== 1 || blackKings !== 1) {
      sendResult(makeResult({}));
      return;
    }

    // Validate FEN structure to avoid crashing Stockfish WASM
    const fenRanks = positionFen.split('/');
    if (fenRanks.length !== 8) {
      sendResult(makeResult({}));
      return;
    }
    // No pawns on rank 1 or 8 (illegal, crashes engine)
    const rank1 = fenRanks[7];
    const rank8 = fenRanks[0];
    if (/[pP]/.test(rank1) || /[pP]/.test(rank8)) {
      debugLog(`Skipping eval: pawns on rank 1/8 in FEN ${positionFen}`);
      sendResult(makeResult({}));
      return;
    }

    if (!engine) {
      sendResult(makeResult({}));
      return;
    }

    const highlightTurn = turnFromHighlight(highlightedSquares, positionFen);
    const turn = highlightTurn ?? guessTurn(prevPositionFen, positionFen);
    const fullFen = buildFullFen(positionFen, turn);

    prevPositionFen = positionFen;
    lastPositionFen = positionFen;

    if (evalAbortController) {
      evalAbortController.abort();
    }
    evalAbortController = new AbortController();
    const { signal } = evalAbortController;

    // Check eval cache — return cached result instantly, then continue deepening
    const cached = cacheGet(fullFen);
    if (cached) {
      lastEval = cached.evaluation;
      lastArrows = cached.arrows;
      const cachedDepth = cached.evaluation.depth;
      debugLog(`Timing: detect=${tDetect}ms preview=${tPreview}ms ${recogDetail} [cache d=${cachedDepth}] total=${Date.now() - startTime}ms`);
      sendResult(makeResult({
        evaluation: cached.evaluation,
        arrows: cached.arrows,
        eval_depth: cachedDepth,
        eval_max_depth: cachedDepth < EVAL_MAX_DEPTH ? EVAL_MAX_DEPTH : undefined,
      }));

      // Continue deepening from cached depth if not at max
      if (cachedDepth < EVAL_MAX_DEPTH) {
        const startDepth = Math.ceil((cachedDepth + 1) / EVAL_DEPTH_STEP) * EVAL_DEPTH_STEP + EVAL_START_DEPTH % EVAL_DEPTH_STEP;
        // Align to the depth stepping sequence
        let nextDepth = EVAL_START_DEPTH;
        while (nextDepth <= cachedDepth) nextDepth += EVAL_DEPTH_STEP;
        (async () => {
          for (let depth = nextDepth; depth <= EVAL_MAX_DEPTH; depth += EVAL_DEPTH_STEP) {
            if (signal.aborted) break;
            const result = await engine!.runDepth(fullFen, depth, 3, signal);
            if (!result) break;
            if (!result.top_moves[0]?.pv?.length) {
              debugLog(`Engine returned empty PV at depth ${depth} — reinitializing`);
              await reinitEngine();
              break;
            }
            const arrows = computeArrows(result.top_moves);
            lastEval = result;
            lastArrows = arrows;
            cachePut(fullFen, { evaluation: result, arrows });
            debugLog(`Eval depth ${result.depth}/${EVAL_MAX_DEPTH} in ${result.elapsed_ms}ms pv=${result.top_moves[0]?.pv?.slice(0, 4).join(' ')}`);
            sendResult(makeResult({
              evaluation: result,
              arrows,
              eval_depth: result.depth,
              eval_max_depth: result.depth < EVAL_MAX_DEPTH ? EVAL_MAX_DEPTH : undefined,
            }));
          }
        })();
      }
      return;
    }

    t = Date.now();
    const firstResult = await engine.runDepth(fullFen, EVAL_START_DEPTH, 3, signal);
    const tEval = Date.now() - t;

    // Detect broken eval (no PV = engine in bad state)
    if (firstResult && !firstResult.top_moves[0]?.pv?.length) {
      debugLog(`Engine returned empty PV — reinitializing`);
      await reinitEngine();
      sendResult(makeResult({ evaluation: lastEval, arrows: lastArrows }));
      return;
    }

    if (firstResult) {
      const arrows = computeArrows(firstResult.top_moves);
      lastEval = firstResult;
      lastArrows = arrows;
      cachePut(fullFen, { evaluation: firstResult, arrows });
      debugLog(`Eval depth ${firstResult.depth}/${EVAL_MAX_DEPTH} in ${firstResult.elapsed_ms}ms pv=${firstResult.top_moves[0]?.pv?.slice(0, 4).join(' ')}`);
      sendResult(makeResult({
        evaluation: firstResult,
        arrows,
        eval_depth: firstResult.depth,
        eval_max_depth: EVAL_MAX_DEPTH,
      }));
    }

    debugLog(`Timing: detect=${tDetect}ms preview=${tPreview}ms ${recogDetail} eval=${tEval}ms d=${firstResult?.depth ?? 'abort'}/${EVAL_MAX_DEPTH} [new pos] total=${Date.now() - startTime}ms`);

    // Continue deepening in background
    if (firstResult && EVAL_START_DEPTH + EVAL_DEPTH_STEP <= EVAL_MAX_DEPTH) {
      (async () => {
        for (let depth = EVAL_START_DEPTH + EVAL_DEPTH_STEP; depth <= EVAL_MAX_DEPTH; depth += EVAL_DEPTH_STEP) {
          if (signal.aborted) break;
          const result = await engine!.runDepth(fullFen, depth, 3, signal);
          if (!result) break;
          // Detect broken eval during deepening
          if (!result.top_moves[0]?.pv?.length) {
            debugLog(`Engine returned empty PV at depth ${depth} — reinitializing`);
            await reinitEngine();
            break;
          }
          const arrows = computeArrows(result.top_moves);
          lastEval = result;
          lastArrows = arrows;
          cachePut(fullFen, { evaluation: result, arrows });
          debugLog(`Eval depth ${result.depth}/${EVAL_MAX_DEPTH} in ${result.elapsed_ms}ms pv=${result.top_moves[0]?.pv?.slice(0, 4).join(' ')}`);
          sendResult(makeResult({
            evaluation: result,
            arrows,
            eval_depth: result.depth,
            eval_max_depth: result.depth < EVAL_MAX_DEPTH ? EVAL_MAX_DEPTH : undefined,
          }));
        }
      })();
    }

  } catch (err) {
    debugLog(`Frame processing error: ${err}`);
  } finally {
    isProcessing = false;
  }
}

function stopCapture(): void {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (videoElement) {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement.remove();
    videoElement = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (previewCanvas) {
    previewCanvas.width = 0;
    previewCanvas.height = 0;
    previewCanvas = null;
    previewCtx = null;
  }
  lastPositionFen = null;
  prevPositionFen = null;
  lastEval = null;
  lastArrows = [];
  lastBoardSample = null;
  lastRecognitionResult = null;
  cachedBbox = null;
  debugLog(`Capture stopped after ${frameCount} frames`);
}

// Listen for IPC commands from main process
window.chessRay.onStartCapture((sourceId) => {
  initAndStartCapture(sourceId);
});

window.chessRay.onStopCapture(() => {
  stopCapture();
});

// Signal to main that all IPC listeners are registered
window.chessRay.sendRendererReady();

// Pull model: if main already has a pending source ID, start capture immediately.
// This handles the case where start-capture IPC was sent before this module loaded.
window.chessRay.getSourceId().then((sourceId) => {
  if (sourceId) {
    debugLog(`Got pending source ID on startup: ${sourceId.slice(0, 30)}...`);
    initAndStartCapture(sourceId);
  }
});
