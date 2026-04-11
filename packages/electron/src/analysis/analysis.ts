/**
 * Analysis renderer — the heavy computation hub (port of offscreen.ts).
 * Runs in a hidden BrowserWindow with full DOM/Web Worker access.
 *
 * Pipeline: capture frame → detect board (YOLO) → recognize pieces (YOLO) → evaluate → arrows
 */

import {
  detectBoard, cropPixels, recognizeBoard,
  computeArrows, compareFen, guessTurn, buildFullFen, detectSequentialMove,
} from '@chessray/core';
import { Chess } from 'chess.js';
import type {
  PixelBuffer, PipelineResult, EvalResult, RecognitionResult, BoardBBox, ArrowDescriptor,
  OrientationSource,
} from '@chessray/core';

import { EVAL_START_DEPTH, EVAL_DEPTH_STEP, EVAL_MAX_DEPTH as DEFAULT_MAX_DEPTH, multiPvForDepth, setMultiPvMax, setMultiPvRamp, cacheGet, cachePut } from './eval-cache.js';
import { sampleBoardPixels, boardUnchanged } from './change-detect.js';
import { getEngine, getRecognizer, getOnnxSession, getOrtModule, reinitEngine } from './engine-init.js';
import { initAndStartCapture, stopCapture, setTargetFps } from './frame-capture.js';

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
      onSetMaxDepth: (cb: (depth: number) => void) => void;
      onSetMultiPvMax: (cb: (n: number) => void) => void;
      onSetMultiPvRamp: (cb: (n: number) => void) => void;
      onSetChangeDetect: (cb: (enabled: boolean) => void) => void;
      onSetTargetFps: (cb: (fps: number) => void) => void;
    };
  }
}

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
let lastHighlightTurn: 'w' | 'b' | null = null;
let lastArrows: ArrowDescriptor[] = [];
let lastFullFen: string | null = null;
let lastPlayedMove: PipelineResult['played_move'] = null;
let cachedOrientation: { prevFen: string; orientation: { flipped: boolean; source: OrientationSource } } | null = null;
let cachedBbox: BoardBBox | null = null;
let frameCount = 0;
let EVAL_MAX_DEPTH = DEFAULT_MAX_DEPTH;
let evalAbortController: AbortController | null = null;

let previewCanvas: HTMLCanvasElement | null = null;
let previewCtx: CanvasRenderingContext2D | null = null;

function debugLog(msg: string): void {
  console.log(`[chessray] ${msg}`);
  window.chessRay.sendDebugLog(msg);
}

function sendResult(result: PipelineResult): void {
  window.chessRay.sendFrameResult(result);
}

function resetPipelineState(): void {
  lastPositionFen = null;
  prevPositionFen = null;
  lastEval = null;
  lastArrows = [];
  lastFullFen = null;
  lastPlayedMove = null;
  cachedOrientation = null;
  lastBoardSample = null;
  lastRecognitionResult = null;
  cachedBbox = null;
  if (previewCanvas) {
    previewCanvas.width = 0;
    previewCanvas.height = 0;
    previewCanvas = null;
    previewCtx = null;
  }
  debugLog(`Capture stopped after ${frameCount} frames`);
}

function resetCaches(): void {
  cachedBbox = null;
  lastBoardSample = null;
}

async function processFrame(imageData: ImageData): Promise<void> {
  const startTime = Date.now();

  try {
    const pixels: PixelBuffer = {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    };

    const onnxSession = getOnnxSession();
    const ortModule = getOrtModule();
    const engine = getEngine();
    const recognizer = getRecognizer();

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

    t = Date.now();
    const boardSample = sampleBoardPixels(cropped.data, cropped.width, cropped.height);
    const visuallyUnchanged = changeDetectEnabled && lastBoardSample && boardUnchanged(lastBoardSample, boardSample);
    const prevBoardSample = lastBoardSample;
    lastBoardSample = boardSample;
    const tChangeDetect = Date.now() - t;

    let recognition: RecognitionResult | null = null;
    let isFlipped = false;
    let orientationSource: OrientationSource | undefined;
    let rawFen = '';
    let highlightedSquares: number[] = [];
    let highlightTurn: 'w' | 'b' | null = null;
    let tRecog = 0;
    let brTiming: { pieces_ms: number; orientation_ms: number; highlights_ms: number; disambiguate_ms: number; pawnRefine_ms: number; turn_ms: number; total_ms: number } | null = null;

    if (visuallyUnchanged && lastRecognitionResult) {
      recognition = lastRecognitionResult;
      rawFen = lastRawFen;
      isFlipped = lastIsFlipped;
      orientationSource = lastOrientationSource;
      highlightedSquares = lastHighlightedSquares;
      highlightTurn = lastHighlightTurn;
    } else {
      t = Date.now();
      if (recognizer) {
        const boardResult = await recognizeBoard(cropped, recognizer, cachedOrientation);
        brTiming = boardResult.timing;

        // Skip mid-animation frames — piece is still sliding, FEN is inconsistent
        if (boardResult.midAnimation) {
          debugLog(`Timing: detect=${tDetect}ms crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms recog=${Date.now() - t}ms [mid-animation, skipped] total=${Date.now() - startTime}ms`);
          // Restore previous board sample so next frame's change detection
          // compares against the last good frame, not the mid-animation one
          lastBoardSample = prevBoardSample;
          // Reuse previous result
          recognition = lastRecognitionResult;
          rawFen = lastRawFen;
          isFlipped = lastIsFlipped;
          orientationSource = lastOrientationSource;
          highlightedSquares = lastHighlightedSquares;
          highlightTurn = lastHighlightTurn;
        } else {
          recognition = boardResult.recognition;
          rawFen = boardResult.rawFen;
          isFlipped = boardResult.flipped;
          orientationSource = boardResult.orientationSource;
          highlightedSquares = boardResult.highlightedSquares;
          highlightTurn = boardResult.turn;
          cachedOrientation = { prevFen: rawFen, orientation: { flipped: isFlipped, source: orientationSource } };
          if (frameCount <= 3) {
            debugLog(`Recognition: rawFen=${rawFen} conf=${recognition.confidence.toFixed(2)}`);
          }
        }
      }
      tRecog = Date.now() - t;

      lastRecognitionResult = recognition;
      lastRawFen = rawFen;
      lastIsFlipped = isFlipped;
      lastOrientationSource = orientationSource;
      lastHighlightedSquares = highlightedSquares;
      lastHighlightTurn = highlightTurn;

    }

    const makeResult = (opts: { evaluation?: EvalResult | null; arrows?: ArrowDescriptor[]; eval_depth?: number; eval_max_depth?: number; game_over?: 'checkmate' | 'stalemate' }): PipelineResult => ({
      board_detection: { found: true, bbox: activeBbox!, confidence: detectionConf },
      recognition,
      evaluation: opts.evaluation ?? null,
      eval_depth: opts.eval_depth,
      eval_max_depth: opts.eval_max_depth,
      arrows: opts.arrows ?? [],
      highlighted_squares: highlightedSquares,
      turn: highlightTurn ?? undefined,
      game_over: opts.game_over,
      flipped: isFlipped,
      orientation_source: orientationSource,
      played_move: lastPlayedMove,
      board_image_url: boardImageUrl,
      frame_dimensions: { width: pixels.width, height: pixels.height },
      total_elapsed_ms: Date.now() - startTime,
    });

    // Build detailed timing string for this frame
    let recogDetail: string;
    if (brTiming) {
      const rt = recognition?.timing;
      const yolo = rt ? `yolo=${rt.prep_ms}+${rt.infer_ms}+${rt.post_ms}` : '';
      recogDetail = `recog=${tRecog}ms(${yolo} orient=${brTiming.orientation_ms} hl=${brTiming.highlights_ms} disamb=${brTiming.disambiguate_ms} pawn=${brTiming.pawnRefine_ms} turn=${brTiming.turn_ms})`;
    } else {
      recogDetail = `recog=${tRecog}ms [cached]`;
    }

    if (!recognition || recognition.confidence < 0.3) {
      debugLog(`Timing: detect=${tDetect}ms crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} [low conf] total=${Date.now() - startTime}ms`);
      sendResult(makeResult({}));
      return;
    }

    const positionFen = recognition.fen;
    // Dedup: same position AND turn hasn't been corrected by highlight detection
    const evalTurnMismatch = highlightTurn && lastEval?.fen?.split(' ')[1] && lastEval.fen.split(' ')[1] !== highlightTurn;
    if (lastPositionFen && compareFen(lastPositionFen, positionFen) && !evalTurnMismatch) {
      debugLog(`Timing: detect=${tDetect}ms crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} [dedup] total=${Date.now() - startTime}ms`);
      sendResult(makeResult({
        evaluation: lastEval,
        arrows: lastArrows,
        eval_depth: lastEval?.depth,
        eval_max_depth: lastEval && lastEval.depth < EVAL_MAX_DEPTH ? EVAL_MAX_DEPTH : undefined,
      }));
      return;
    }
    if (evalTurnMismatch) {
      debugLog(`Turn corrected by highlight: eval had '${lastEval!.fen.split(' ')[1]}' but highlight says '${highlightTurn}' — re-evaluating`);
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

    t = Date.now();
    const turn = highlightTurn ?? guessTurn(prevPositionFen, positionFen);
    const fullFen = buildFullFen(positionFen, turn);
    const tFenBuild = Date.now() - t;

    // Detect sequential move before updating lastFullFen
    // (detection needs the PREVIOUS fullFen)

    // Detect checkmate/stalemate — skip engine if game is over
    t = Date.now();
    let gameOver: 'checkmate' | 'stalemate' | undefined;
    try {
      const chess = new Chess(fullFen);
      if (chess.isCheckmate()) gameOver = 'checkmate';
      else if (chess.isStalemate()) gameOver = 'stalemate';
    } catch { /* invalid FEN — continue to engine */ }
    const tGameOver = Date.now() - t;

    if (gameOver) {
      debugLog(`Game over: ${gameOver}`);
      sendResult(makeResult({ game_over: gameOver }));
      return;
    }

    // Detect if this position is one legal move from the previous
    t = Date.now();
    lastPlayedMove = null;
    let prevBestScore: number | null = null;
    if (lastFullFen && lastEval) {
      const seqMove = detectSequentialMove(lastFullFen, positionFen);
      if (seqMove) {
        const prevBest = lastEval.top_moves[0];
        prevBestScore = prevBest?.score_cp ?? null;
        const matchingMove = lastEval.top_moves.find(m => m.move === seqMove.uci);
        const lossCp = matchingMove ? matchingMove.loss_cp : null;
        lastPlayedMove = {
          from: seqMove.uci.slice(0, 2),
          to: seqMove.uci.slice(2, 4),
          uci: seqMove.uci,
          san: seqMove.san,
          loss_cp: lossCp ?? 0,
        };
        if (lossCp !== null) {
          debugLog(`Sequential move: ${seqMove.san} (${seqMove.uci}) loss=${lossCp}cp`);
        } else {
          debugLog(`Sequential move: ${seqMove.san} (${seqMove.uci}) — not in top ${lastEval.top_moves.length}, loss pending`);
        }
      }
    }
    const tSeqMove = Date.now() - t;

    // Track whether loss was already known from previous top moves
    const playedMoveLossKnown = lastPlayedMove ? lastPlayedMove.loss_cp !== 0 : true;

    // Update played move loss once the new eval comes in (for moves not in previous top N)
    function updatePlayedMoveLoss(evalResult: EvalResult): void {
      if (!lastPlayedMove || prevBestScore === null || playedMoveLossKnown) return;
      // loss = prevBest + currBest (both from side-to-move perspective)
      const currBest = evalResult.top_moves[0]?.score_cp ?? 0;
      const loss = Math.max(0, prevBestScore + currBest);
      lastPlayedMove = { ...lastPlayedMove, loss_cp: loss };
      debugLog(`Played move loss updated: ${lastPlayedMove.san} loss=${loss}cp (prev=${prevBestScore} curr=${currBest})`);
    }

    prevPositionFen = positionFen;
    lastPositionFen = positionFen;
    lastFullFen = fullFen;
    // Clear stale eval so dedup frames don't show old position's eval
    lastEval = null;
    lastArrows = [];

    if (evalAbortController) {
      evalAbortController.abort();
    }
    evalAbortController = new AbortController();
    const { signal } = evalAbortController;

    // Check eval cache — return cached result instantly, then continue deepening
    const cached = cacheGet(fullFen);
    if (cached) {
      updatePlayedMoveLoss(cached.evaluation);
      lastEval = cached.evaluation;
      lastArrows = cached.arrows;
      const cachedDepth = cached.evaluation.depth;
      debugLog(`Timing: detect=${tDetect}ms crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} fen=${tFenBuild}ms gameOver=${tGameOver}ms seqMove=${tSeqMove}ms [cache d=${cachedDepth}] total=${Date.now() - startTime}ms`);
      sendResult(makeResult({
        evaluation: cached.evaluation,
        arrows: cached.arrows,
        eval_depth: cachedDepth,
        eval_max_depth: cachedDepth < EVAL_MAX_DEPTH ? EVAL_MAX_DEPTH : undefined,
      }));

      // Continue deepening from cached depth if not at max
      if (cachedDepth < EVAL_MAX_DEPTH) {
        // Align to the depth stepping sequence
        let nextDepth = EVAL_START_DEPTH;
        while (nextDepth <= cachedDepth) nextDepth += EVAL_DEPTH_STEP;
        (async () => {
          for (let depth = nextDepth; depth <= EVAL_MAX_DEPTH; depth += EVAL_DEPTH_STEP) {
            if (signal.aborted) break;
            const result = await engine!.runDepth(fullFen, depth, multiPvForDepth(depth), signal);
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
    const firstResult = await engine.runDepth(fullFen, EVAL_START_DEPTH, multiPvForDepth(EVAL_START_DEPTH), signal);
    const tEval = Date.now() - t;

    // Detect broken eval (no PV = engine in bad state)
    if (firstResult && !firstResult.top_moves[0]?.pv?.length) {
      debugLog(`Engine returned empty PV — reinitializing`);
      await reinitEngine();
      sendResult(makeResult({ evaluation: lastEval, arrows: lastArrows }));
      return;
    }

    if (firstResult) {
      updatePlayedMoveLoss(firstResult);
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

    debugLog(`Timing: detect=${tDetect}ms crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} fen=${tFenBuild}ms gameOver=${tGameOver}ms seqMove=${tSeqMove}ms eval=${tEval}ms d=${firstResult?.depth ?? 'abort'}/${EVAL_MAX_DEPTH} [new pos] total=${Date.now() - startTime}ms`);

    // Continue deepening in background
    if (firstResult && EVAL_START_DEPTH + EVAL_DEPTH_STEP <= EVAL_MAX_DEPTH) {
      (async () => {
        for (let depth = EVAL_START_DEPTH + EVAL_DEPTH_STEP; depth <= EVAL_MAX_DEPTH; depth += EVAL_DEPTH_STEP) {
          if (signal.aborted) break;
          const result = await engine!.runDepth(fullFen, depth, multiPvForDepth(depth), signal);
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
  }
}

// Listen for IPC commands from main process
window.chessRay.onStartCapture((sourceId) => {
  frameCount = 0;
  initAndStartCapture(sourceId, (imageData) => processFrame(imageData), resetCaches);
});

window.chessRay.onStopCapture(() => {
  stopCapture(resetPipelineState);
});

window.chessRay.onSetMaxDepth((depth: number) => {
  debugLog(`Max depth changed to ${depth}`);
  EVAL_MAX_DEPTH = depth;
});

window.chessRay.onSetMultiPvMax((n: number) => {
  debugLog(`MultiPV max changed to ${n}`);
  setMultiPvMax(n);
});

window.chessRay.onSetMultiPvRamp((n: number) => {
  debugLog(`MultiPV ramp changed to ${n} steps/line`);
  setMultiPvRamp(n);
});

let changeDetectEnabled = true;
window.chessRay.onSetChangeDetect((enabled: boolean) => {
  debugLog(`Change detection ${enabled ? 'enabled' : 'disabled'}`);
  changeDetectEnabled = enabled;
});

window.chessRay.onSetTargetFps((fps: number) => {
  debugLog(`Target FPS changed to ${fps}`);
  setTargetFps(fps);
});

// Signal to main that all IPC listeners are registered
window.chessRay.sendRendererReady();

// Pull model: if main already has a pending source ID, start capture immediately.
// This handles the case where start-capture IPC was sent before this module loaded.
window.chessRay.getSourceId().then((sourceId) => {
  if (sourceId) {
    debugLog(`Got pending source ID on startup: ${sourceId.slice(0, 30)}...`);
    frameCount = 0;
    initAndStartCapture(sourceId, (imageData) => processFrame(imageData), resetCaches);
  }
});
