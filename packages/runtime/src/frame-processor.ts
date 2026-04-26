/**
 * FrameProcessor — the per-frame pipeline, decoupled from the renderer.
 *
 * Lives at the boundary between platform-specific wiring (IPC, DOM) and the
 * detection/evaluation pipeline. `analysis.ts` (the production renderer) owns
 * one instance and forwards captured frames to `processFrame`. Tests construct
 * their own instance with a stub engine and replay a sequence of PNGs,
 * exercising the exact same code path the app uses.
 *
 * All cross-frame state lives as private fields. Dependencies (engine, ONNX
 * session, log/sendResult sinks, preview-URL encoder) are injected via
 * `FrameProcessorDeps` so the same class runs in the renderer and in Node.
 */

import {
  detectBoard, cropPixels, recognizeBoard,
  compareFen, guessTurn, buildFullFen, detectSequentialMove, isStartingPosition,
  type EvalEngine,
} from '@chessray/core';
import { Chess } from 'chess.js';
import type {
  PixelBuffer, EvalResult, RecognitionResult, BoardBBox,
  OrientationSource, Turn,
} from '@chessray/core';
import type { PipelineResult, ArrowDescriptor, GameOver } from '@chessray/core';

import {
  EVAL_START_DEPTH, EVAL_DEPTH_STEP, EVAL_MAX_DEPTH as DEFAULT_MAX_DEPTH,
  EVAL_MULTI_PV_START, EVAL_MULTI_PV_MAX,
  cacheGet, cachePut,
} from './eval-cache.js';
import { sampleBoardPixels, sampleFrameOutsideBbox, boardUnchanged } from './change-detect.js';
import { computeArrows } from '@chessray/core';

/** ImageData-like shape — compatible with the real DOM `ImageData` (renderer)
 *  and with a plain `{ data, width, height }` object (Node tests). */
export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Per-frame capture metadata forwarded from the capture layer. Tests may omit it. */
export interface FrameMeta {
  capture_ms: number;
  captured_at: number;
}

export interface FrameProcessorDeps {
  onnxSession: unknown;
  ortModule: unknown;
  recognizer: unknown;
  /** Getter so reinit can swap the engine without reconstructing the processor. */
  getEngine: () => EvalEngine | null;
  /** Called when the engine returns an empty PV (signals a crash). */
  reinitEngine: () => Promise<void>;
  sendResult: (r: PipelineResult) => void;
  log: (msg: string) => void;
  /** Produces a data URL for the cropped board preview. Return '' to skip (tests). */
  encodePreviewUrl?: (cropped: PixelBuffer) => string;
  changeDetectEnabled?: boolean;
  multiPvMax?: number;
}

export class FrameProcessor {
  // ── Pipeline state ──
  private lastPositionFen: string | null = null;
  private prevPositionFen: string | null = null;
  private lastEval: EvalResult | null = null;
  /** Last eval we'd want to show in the bar — survives the brief `lastEval = null`
   *  window between detecting a new position and the first depth completing,
   *  so the eval bar can fall back to it (marked stale) instead of disappearing. */
  private lastDisplayEval: EvalResult | null = null;
  /** Tracks how long the same "new" FEN has been classified as intermediate.
   *  Once the same new FEN has been pending for ≥ INTERMEDIATE_RELEASE_MS we
   *  give up and accept it as the real position — protects against premoves
   *  and stuck-highlight cases where the highlight squares never change after
   *  the position settles. */
  private intermediatePendingFen: string | null = null;
  private intermediatePendingTs = 0;
  private static readonly INTERMEDIATE_RELEASE_MS = 800;
  private lastBoardSample: Uint8Array | null = null;
  private lastRecognitionResult: RecognitionResult | null = null;
  private lastRawFen: string = '';
  private lastIsFlipped = false;
  private lastOrientationSource: OrientationSource | undefined;
  private lastHighlightedSquares: number[] = [];
  private lastHighlightTurn: Turn | null = null;
  private lastInvalidHighlights = false;
  private lastSquareColors: PipelineResult['square_colors'] | undefined;
  private lastHighlightDebug: PipelineResult['highlight_debug'] | undefined;
  private lastArrows: ArrowDescriptor[] = [];
  /** Sticky game-over flag for the current `lastPositionFen`. Once set we keep
   *  asserting it on dedup / intermediate-frame re-emissions so the overlay
   *  pill doesn't flicker across frames that short-circuit before the normal
   *  game-over check runs. Cleared when a new position is accepted. */
  private lastGameOver: GameOver | undefined = undefined;
  private lastFullFen: string | null = null;
  private lastPlayedMove: PipelineResult['played_move'] = null;
  private cachedOrientation: { prevFen: string; orientation: { flipped: boolean; source: OrientationSource } } | null = null;
  private cachedBbox: BoardBBox | null = null;
  /** Fingerprint of the frame outside the cached bbox; when unchanged, skip board detection. */
  private lastFrameSample: Uint8Array | null = null;
  /** Frames since we last ran detectBoard — forces a refresh every N frames so a drifted bbox eventually self-corrects. */
  private framesSinceDetect = 0;
  private static readonly DETECT_REFRESH_FRAMES = 30;
  private frameCount = 0;
  private evalAbortController: AbortController | null = null;

  // ── Tunables (overridable at runtime) ──
  /** Search ceiling for iterative deepening. The loop almost always terminates
   *  earlier via the AbortController (FEN change) or because Stockfish saturates;
   *  this is just an upper safety bound. Deliberately not user-configurable. */
  private readonly maxDepth: number = DEFAULT_MAX_DEPTH;
  private multiPvMax: number;
  private changeDetectEnabled: boolean;
  /** User-supplied orientation override. null = use auto-detection. */
  private manualFlip: boolean | null = null;

  constructor(private deps: FrameProcessorDeps) {
    this.multiPvMax = deps.multiPvMax ?? EVAL_MULTI_PV_MAX;
    this.changeDetectEnabled = deps.changeDetectEnabled ?? true;
  }

  resetPipelineState(): void {
    this.lastPositionFen = null;
    this.prevPositionFen = null;
    this.lastEval = null;
    this.lastDisplayEval = null;
    this.intermediatePendingFen = null;
    this.intermediatePendingTs = 0;
    this.lastArrows = [];
    this.lastFullFen = null;
    this.lastPlayedMove = null;
    this.cachedOrientation = null;
    this.lastBoardSample = null;
    this.lastRecognitionResult = null;
    this.lastSquareColors = undefined;
    this.lastHighlightDebug = undefined;
    this.cachedBbox = null;
    this.deps.log(`Capture stopped after ${this.frameCount} frames`);
  }

  resetCaches(): void {
    this.cachedBbox = null;
    this.lastBoardSample = null;
    this.lastFrameSample = null;
    this.framesSinceDetect = 0;
  }

  resetFrameCount(): void {
    this.frameCount = 0;
  }

  setMultiPvMax(n: number): void { this.multiPvMax = n; }
  setChangeDetect(on: boolean): void { this.changeDetectEnabled = on; }
  setManualFlip(v: boolean | null): void {
    this.manualFlip = v;
    // Clear the orientation cache so the next frame re-evaluates with the
    // new override (or re-runs auto-detection when cleared to null).
    this.cachedOrientation = null;
  }

  /** First (shallowest) pass gets a small quick-look count; every deeper pass
   *  uses the user's selected max. No ramp. */
  private multiPvForDepth(depth: number): number {
    if (depth === EVAL_START_DEPTH) return Math.min(EVAL_MULTI_PV_START, this.multiPvMax);
    return this.multiPvMax;
  }

  async processFrame(imageData: ImageDataLike, frameMeta?: FrameMeta): Promise<void> {
    const startTime = Date.now();
    const log = this.deps.log;
    const sendResult = this.deps.sendResult;
    const captureMs = frameMeta?.capture_ms ?? 0;
    /** Last completed eval depth's elapsed_ms — survives across frames so the timing
     *  panel keeps showing the most recent eval cost while async eval depths roll in. */
    const lastEvalMs = this.lastEval?.elapsed_ms;
    const lastEvalDepth = this.lastEval?.depth;

    try {
      const pixels: PixelBuffer = {
        data: imageData.data,
        width: imageData.width,
        height: imageData.height,
      };

      const onnxSession = this.deps.onnxSession;
      const ortModule = this.deps.ortModule;
      const engine = this.deps.getEngine();
      const recognizer = this.deps.recognizer;

      let activeBbox = this.cachedBbox;
      let detectionConf = 1;
      let tDetect = 0;
      let tFingerprint = 0;
      let detectSkipped = false;
      {
        // Cheap fingerprint: sample the frame outside the cached bbox. When it's
        // unchanged the UI chrome around the board hasn't moved, so the bbox is
        // still valid — skipping detectBoard saves ~250ms/frame. Refresh
        // periodically as a safety net against drift.
        const tFp = Date.now();
        const frameSample = sampleFrameOutsideBbox(pixels.data, pixels.width, pixels.height, this.cachedBbox);
        const frameUnchanged = this.lastFrameSample !== null && boardUnchanged(this.lastFrameSample, frameSample);
        tFingerprint = Date.now() - tFp;
        const shouldRefresh = this.framesSinceDetect >= FrameProcessor.DETECT_REFRESH_FRAMES;
        const canSkip = this.cachedBbox !== null && frameUnchanged && !shouldRefresh;
        this.lastFrameSample = frameSample;

        if (canSkip) {
          activeBbox = this.cachedBbox;
          this.framesSinceDetect++;
          detectSkipped = true;
        } else {
          const t0 = Date.now();
          const detection = await detectBoard(onnxSession, ortModule, pixels.data, pixels.width, pixels.height);
          activeBbox = detection.bbox;
          detectionConf = detection.confidence;
          if (detection.bbox) this.cachedBbox = detection.bbox;
          tDetect = Date.now() - t0;
          this.framesSinceDetect = 0;
          if (this.frameCount < 10) {
            const bb = detection.bbox ? `bbox=${detection.bbox.x},${detection.bbox.y},${detection.bbox.width}x${detection.bbox.height}` : 'no bbox';
            log(`Frame ${this.frameCount}: ${pixels.width}x${pixels.height} | ${bb} | found=${detection.found} conf=${detectionConf.toFixed(2)} time=${detection.elapsed_ms}ms`);
          }
        }
      }
      this.frameCount++;

      if (!activeBbox) {
        sendResult({
          board_detection: { found: false, bbox: null, confidence: 0 },
          recognition: null,
          evaluation: null,
          arrows: [],
          detection_status: 'No board detected',
          total_elapsed_ms: Date.now() - startTime,
        });
        return;
      }

      let t = Date.now();
      const cropped = cropPixels(pixels, activeBbox);
      const tCrop = Date.now() - t;
      t = Date.now();
      const boardImageUrl = this.deps.encodePreviewUrl?.(cropped) ?? '';
      const tPreview = Date.now() - t;

      t = Date.now();
      const boardSample = sampleBoardPixels(cropped.data, cropped.width, cropped.height);
      const visuallyUnchanged = this.changeDetectEnabled && this.lastBoardSample && boardUnchanged(this.lastBoardSample, boardSample);
      const prevBoardSample = this.lastBoardSample;
      this.lastBoardSample = boardSample;
      // Snapshot the committed per-frame state before any fresh-recognition
      // updates overwrite `this.last*`. The intermediate-frame branch needs
      // to emit the PREVIOUS committed recognition (not whatever recognition
      // just ran this frame) so the overlay doesn't see the recog FEN change
      // mid-move and wipe its arrow animation state.
      const prevRecognitionResult = this.lastRecognitionResult;
      const prevRawFen = this.lastRawFen;
      const prevIsFlipped = this.lastIsFlipped;
      const prevOrientationSource = this.lastOrientationSource;
      const prevHighlightedSquaresCommitted = this.lastHighlightedSquares.slice();
      const prevHighlightTurn = this.lastHighlightTurn;
      const prevSquareColors = this.lastSquareColors;
      const tChangeDetect = Date.now() - t;

      let recognition: RecognitionResult | null = null;
      let isFlipped = false;
      let orientationSource: OrientationSource | undefined;
      let rawFen = '';
      let highlightedSquares: number[] = [];
      let highlightTurn: Turn | null = null;
      let invalidHighlights = false;
      let tRecog = 0;
      let brTiming: { pieces_ms: number; orientation_ms: number; highlights_ms: number; disambiguate_ms: number; turn_ms: number; total_ms: number } | null = null;
      let detectionStatus: string | undefined;
      const prevHighlightedSquares = [...this.lastHighlightedSquares];

      let squareColors: PipelineResult['square_colors'] = this.lastSquareColors;
      let highlightDebug: PipelineResult['highlight_debug'] = this.lastHighlightDebug;
      if (visuallyUnchanged && this.lastRecognitionResult) {
        recognition = this.lastRecognitionResult;
        rawFen = this.lastRawFen;
        isFlipped = this.lastIsFlipped;
        orientationSource = this.lastOrientationSource;
        highlightedSquares = this.lastHighlightedSquares;
        highlightTurn = this.lastHighlightTurn;
        invalidHighlights = this.lastInvalidHighlights;
      } else {
        t = Date.now();
        if (recognizer) {
          const boardResult = await recognizeBoard(cropped, recognizer as Parameters<typeof recognizeBoard>[1], this.cachedOrientation, this.manualFlip);
          brTiming = boardResult.timing;

          // Always capture highlight debug info, even on mid-animation frames
          const correctedBoard: (string | null)[] = new Array(64).fill(null);
          {
            const rows = boardResult.correctedFen.split('/');
            for (let r = 0; r < 8; r++) {
              let f = 0;
              for (const ch of rows[r]) {
                if (ch >= '1' && ch <= '8') f += parseInt(ch);
                else { correctedBoard[r * 8 + f] = ch; f++; }
              }
            }
          }
          const squareToIdx = (sq: string): number => {
            const file = sq.charCodeAt(0) - 97;
            const rank = 8 - parseInt(sq[1], 10);
            return rank * 8 + file;
          };
          highlightDebug = {
            candidates: boardResult.highlightCandidates.map(c => ({
              square: c.square,
              score: c.score,
              piece: correctedBoard[squareToIdx(c.square)],
            })),
            medians: boardResult.highlightMedians,
            disambiguation: boardResult.highlightDisambiguation,
            invalidHighlights: boardResult.invalidHighlights,
            midAnimation: boardResult.midAnimation,
            timing: {
              highlights_ms: boardResult.timing.highlights_ms,
              disambiguate_ms: boardResult.timing.disambiguate_ms,
            },
          };

          // Log highlight detection detail for diagnosing missed highlights.
          const rawToCorrectedSq = (rawIdx: number): string => {
            const i = boardResult.flipped ? 63 - rawIdx : rawIdx;
            const file = i % 8;
            const rank = 8 - Math.floor(i / 8);
            return `${String.fromCharCode(97 + file)}${rank}`;
          };
          const topRaw = (boardResult.highlightScores ?? []).slice(0, 10);
          const scoresStr = topRaw.map(s => {
            const sq = rawToCorrectedSq(s.idx);
            const piece = correctedBoard[squareToIdx(sq)] ?? '·';
            const below = s.dist < 18 ? '↓' : '';
            return `${sq}:${s.dist.toFixed(0)}${piece}${below}`;
          }).join(' ');
          const ml = boardResult.highlightMedians.light;
          const md = boardResult.highlightMedians.dark;
          const pairsStr = boardResult.highlightDisambiguation.validPairs
            .map(p => {
              const natural = Math.max(p.srcNaturalness, p.destNaturalness) <= 0.08 ? 'nat' : 'ann';
              return `${p.src}→${p.dest}(${p.piece},p${p.pass},s=${p.combinedScore.toFixed(0)},${natural})`;
            }).join(' ');
          const w = boardResult.highlightDisambiguation.winner;
          const winnerStr = w ? `${w.src}→${w.dest}[${w.reason}]` : 'none';
          const flags: string[] = [];
          if (boardResult.invalidHighlights) flags.push('invalid');
          if (boardResult.midAnimation) flags.push('mid-anim');
          const flagsStr = flags.length ? ` flags=${flags.join(',')}` : '';
          log(
            `hl: scores=[${scoresStr}]`
            + ` medians=L(${ml[0]},${ml[1]},${ml[2]})/D(${md[0]},${md[1]},${md[2]})`
            + ` pairs=[${pairsStr}]+${boardResult.highlightDisambiguation.rejectedCount}rej`
            + ` winner=${winnerStr}${flagsStr}`
          );

          if (boardResult.midAnimation) {
            detectionStatus = 'Mid-animation — piece sliding';
            log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms recog=${Date.now() - t}ms [mid-animation, skipped] total=${Date.now() - startTime}ms`);
            this.lastBoardSample = prevBoardSample;
            recognition = this.lastRecognitionResult;
            rawFen = this.lastRawFen;
            isFlipped = this.lastIsFlipped;
            orientationSource = this.lastOrientationSource;
            highlightedSquares = this.lastHighlightedSquares;
            highlightTurn = this.lastHighlightTurn;
          } else {
            recognition = boardResult.recognition;
            rawFen = boardResult.rawFen;
            isFlipped = boardResult.flipped;
            orientationSource = boardResult.orientationSource;
            highlightedSquares = boardResult.highlightedSquares;
            highlightTurn = boardResult.turn;
            invalidHighlights = boardResult.invalidHighlights;
            squareColors = boardResult.highlightMedians;
            this.cachedOrientation = { prevFen: rawFen, orientation: { flipped: isFlipped, source: orientationSource } };
            if (this.frameCount <= 3) {
              log(`Recognition: rawFen=${rawFen} conf=${recognition.confidence.toFixed(2)}`);
            }
          }
        }
        tRecog = Date.now() - t;

        this.lastRecognitionResult = recognition;
        this.lastRawFen = rawFen;
        this.lastIsFlipped = isFlipped;
        this.lastOrientationSource = orientationSource;
        this.lastHighlightedSquares = highlightedSquares;
        this.lastHighlightTurn = highlightTurn;
        this.lastInvalidHighlights = invalidHighlights;
        this.lastSquareColors = squareColors;
        this.lastHighlightDebug = highlightDebug;
      }

      const self = this;
      // Mutable accumulators for stages that run after makeResult is defined.
      // makeResult snapshots them at call time so each sendResult reflects the
      // work actually completed before that point.
      let tFenBuild = 0;
      let tGameOver = 0;
      let tSeqMove = 0;
      // Pipeline duration is frozen at the first sendResult. makeResult is also
      // reused by the async eval-depth loop seconds later — without freezing,
      // `Date.now() - startTime` would balloon to include the eval wait, even
      // though no pipeline work happened in that interval.
      let frozenPipelineMs: number | null = null;
      const makeResult = (opts: { evaluation?: EvalResult | null; arrows?: ArrowDescriptor[]; eval_depth?: number; eval_max_depth?: number; game_over?: GameOver; stale_eval?: boolean }): PipelineResult => {
        const now = Date.now();
        if (frozenPipelineMs === null) frozenPipelineMs = now - startTime;
        const evalRes = opts.evaluation ?? null;
        const evalMs = evalRes?.elapsed_ms ?? lastEvalMs;
        const evalDepth = opts.eval_depth ?? lastEvalDepth;
        const recogBreakdown = brTiming
          ? {
              yolo_prep_ms: recognition?.timing?.prep_ms ?? 0,
              yolo_infer_ms: recognition?.timing?.infer_ms ?? 0,
              yolo_post_ms: recognition?.timing?.post_ms ?? 0,
              pieces_ms: brTiming.pieces_ms,
              orientation_ms: brTiming.orientation_ms,
              highlights_ms: brTiming.highlights_ms,
              disambiguate_ms: brTiming.disambiguate_ms,
              turn_ms: brTiming.turn_ms,
            }
          : null;
        return {
          board_detection: { found: true, bbox: activeBbox!, confidence: detectionConf },
          recognition,
          evaluation: evalRes,
          eval_depth: opts.eval_depth,
          eval_max_depth: opts.eval_max_depth,
          stale_eval: opts.stale_eval,
          arrows: opts.arrows ?? [],
          highlighted_squares: highlightedSquares,
          turn: highlightTurn ?? undefined,
          game_over: opts.game_over,
          flipped: isFlipped,
          orientation_source: orientationSource,
          played_move: self.lastPlayedMove,
          detection_status: detectionStatus,
          board_image_url: boardImageUrl,
          frame_dimensions: { width: pixels.width, height: pixels.height },
          square_colors: squareColors,
          highlight_debug: highlightDebug,
          frame_timing: {
            capture_ms: captureMs,
            fingerprint_ms: tFingerprint,
            detect_ms: tDetect,
            detect_skipped: detectSkipped,
            crop_ms: tCrop,
            preview_ms: tPreview,
            change_detect_ms: tChangeDetect,
            recog_ms: tRecog,
            recog_cached: brTiming === null,
            recog_breakdown: recogBreakdown,
            fen_build_ms: tFenBuild,
            game_over_ms: tGameOver,
            seq_move_ms: tSeqMove,
            pipeline_ms: frozenPipelineMs,
            sent_at: now,
            eval_ms: evalMs,
            eval_depth: evalDepth,
          },
          total_elapsed_ms: frozenPipelineMs,
        };
      };

      let recogDetail: string;
      if (brTiming) {
        const rt = recognition?.timing;
        const yolo = rt ? `yolo=${rt.prep_ms}+${rt.infer_ms}+${rt.post_ms}` : '';
        recogDetail = `recog=${tRecog}ms(${yolo} orient=${brTiming.orientation_ms} hl=${brTiming.highlights_ms} disamb=${brTiming.disambiguate_ms} turn=${brTiming.turn_ms})`;
      } else {
        recogDetail = `recog=${tRecog}ms [cached]`;
      }

      if (!recognition || recognition.confidence < 0.3) {
        detectionStatus = `Low confidence: ${recognition ? (recognition.confidence * 100).toFixed(0) + '%' : 'no recognition'}`;
        log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} [low conf] total=${Date.now() - startTime}ms`);
        // Use the same display fallback as the rest of the function so the bar
        // doesn't disappear on a transient low-confidence frame.
        const fallbackEval = this.lastEval ?? this.lastDisplayEval;
        sendResult(makeResult(fallbackEval
          ? { evaluation: fallbackEval, arrows: this.lastEval ? this.lastArrows : [], eval_depth: fallbackEval.depth, stale_eval: true }
          : {}));
        return;
      }

      const positionFen = recognition.fen;

      // Helper: opts that prefer the current `lastEval`, falling back to the
      // last-displayed eval (marked stale) so the bar doesn't disappear in the
      // gap between [new pos] resetting `lastEval` and the first depth
      // completing.
      const evalDisplayOpts = (): Parameters<typeof makeResult>[0] => {
        if (this.lastEval) {
          return {
            evaluation: this.lastEval,
            arrows: this.lastArrows,
            eval_depth: this.lastEval.depth,
            eval_max_depth: this.lastEval.depth < this.maxDepth ? this.maxDepth : undefined,
          };
        }
        if (this.lastDisplayEval) {
          return {
            evaluation: this.lastDisplayEval,
            arrows: [],
            stale_eval: true,
            eval_depth: this.lastDisplayEval.depth,
            eval_max_depth: this.lastDisplayEval.depth < this.maxDepth ? this.maxDepth : undefined,
          };
        }
        return {};
      };

      if (highlightedSquares.length === 0 && !isStartingPosition(positionFen)) {
        detectionStatus = invalidHighlights
          ? 'Invalid highlights — no legal move'
          : 'No highlights — waiting for move to complete';
        const reason = invalidHighlights ? 'invalid highlights' : 'no highlights';
        log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} [${reason}] total=${Date.now() - startTime}ms`);
        sendResult(makeResult(evalDisplayOpts()));
        return;
      }

      // Dedup: same position AND turn hasn't been corrected by highlight detection
      const evalTurnMismatch = highlightTurn && this.lastEval?.fen?.split(' ')[1] && this.lastEval.fen.split(' ')[1] !== highlightTurn;
      if (this.lastPositionFen && compareFen(this.lastPositionFen, positionFen) && !evalTurnMismatch) {
        detectionStatus = 'Position unchanged';
        log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} [dedup] total=${Date.now() - startTime}ms`);
        sendResult(makeResult({ ...evalDisplayOpts(), game_over: this.lastGameOver }));
        return;
      }
      if (evalTurnMismatch) {
        log(`Turn corrected by highlight: eval had '${this.lastEval!.fen.split(' ')[1]}' but highlight says '${highlightTurn}' — re-evaluating`);
      }

      // Intermediate frame: FEN changed but highlights didn't — piece mid-transition
      if (this.lastPositionFen && !compareFen(this.lastPositionFen, positionFen) &&
          highlightedSquares.length === 2 && prevHighlightedSquares.length === 2 &&
          highlightedSquares[0] === prevHighlightedSquares[0] &&
          highlightedSquares[1] === prevHighlightedSquares[1]) {
        // Stability gate: only treat as intermediate if the same new FEN
        // hasn't been pending for too long. After INTERMEDIATE_RELEASE_MS
        // we give up and accept it (handles premoves / stuck highlights).
        const now = Date.now();
        if (this.intermediatePendingFen === positionFen) {
          if (now - this.intermediatePendingTs >= FrameProcessor.INTERMEDIATE_RELEASE_MS) {
            log(`Intermediate stability window exceeded (${FrameProcessor.INTERMEDIATE_RELEASE_MS}ms) — accepting new position`);
            this.intermediatePendingFen = null;
            // Fall through to the normal new-position handling below.
          } else {
            // Still within the stability window — keep treating as intermediate.
            detectionStatus = 'Intermediate frame — highlights unchanged';
            log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} [intermediate, skipped, ${now - this.intermediatePendingTs}ms] total=${Date.now() - startTime}ms`);
            this.lastBoardSample = prevBoardSample;
            this.lastRecognitionResult = prevRecognitionResult;
            this.lastRawFen = prevRawFen;
            this.lastIsFlipped = prevIsFlipped;
            this.lastOrientationSource = prevOrientationSource;
            this.lastHighlightedSquares = prevHighlightedSquaresCommitted;
            this.lastHighlightTurn = prevHighlightTurn;
            this.lastSquareColors = prevSquareColors;
            recognition = prevRecognitionResult;
            rawFen = prevRawFen;
            isFlipped = prevIsFlipped;
            orientationSource = prevOrientationSource;
            highlightedSquares = prevHighlightedSquaresCommitted;
            highlightTurn = prevHighlightTurn;
            squareColors = prevSquareColors;
            sendResult(makeResult(evalDisplayOpts()));
            return;
          }
        } else {
          // Different new FEN (or first observation) — start a fresh window.
          this.intermediatePendingFen = positionFen;
          this.intermediatePendingTs = now;
          detectionStatus = 'Intermediate frame — highlights unchanged';
          log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} [intermediate, skipped] total=${Date.now() - startTime}ms`);
          this.lastBoardSample = prevBoardSample;
          this.lastRecognitionResult = prevRecognitionResult;
          this.lastRawFen = prevRawFen;
          this.lastIsFlipped = prevIsFlipped;
          this.lastOrientationSource = prevOrientationSource;
          this.lastHighlightedSquares = prevHighlightedSquaresCommitted;
          this.lastHighlightTurn = prevHighlightTurn;
          this.lastSquareColors = prevSquareColors;
          recognition = prevRecognitionResult;
          rawFen = prevRawFen;
          isFlipped = prevIsFlipped;
          orientationSource = prevOrientationSource;
          highlightedSquares = prevHighlightedSquaresCommitted;
          highlightTurn = prevHighlightTurn;
          squareColors = prevSquareColors;
          sendResult(makeResult(evalDisplayOpts()));
          return;
        }
      }
      // Past any intermediate state — clear the pending window so the next
      // mid-animation event starts fresh.
      this.intermediatePendingFen = null;

      const whiteKings = (positionFen.match(/K/g) || []).length;
      const blackKings = (positionFen.match(/k/g) || []).length;
      if (whiteKings !== 1 || blackKings !== 1) {
        detectionStatus = `Invalid: ${whiteKings}K ${blackKings}k`;
        sendResult(makeResult(evalDisplayOpts()));
        return;
      }

      const fenRanks = positionFen.split('/');
      if (fenRanks.length !== 8) {
        detectionStatus = 'Invalid FEN structure';
        sendResult(makeResult(evalDisplayOpts()));
        return;
      }
      const rank1 = fenRanks[7];
      const rank8 = fenRanks[0];
      if (/[pP]/.test(rank1) || /[pP]/.test(rank8)) {
        detectionStatus = 'Pawns on rank 1/8 — invalid';
        log(`Skipping eval: pawns on rank 1/8 in FEN ${positionFen}`);
        sendResult(makeResult(evalDisplayOpts()));
        return;
      }

      if (!engine) {
        sendResult(makeResult(evalDisplayOpts()));
        return;
      }

      t = Date.now();
      const turn = highlightTurn ?? guessTurn(this.prevPositionFen, positionFen);
      const fullFen = buildFullFen(positionFen, turn);
      tFenBuild = Date.now() - t;

      t = Date.now();
      let gameOver: GameOver | undefined;
      try {
        const chess = new Chess(fullFen);
        if (chess.isCheckmate()) gameOver = 'checkmate';
        else if (chess.isStalemate()) gameOver = 'stalemate';
      } catch { /* invalid FEN — continue to engine */ }
      tGameOver = Date.now() - t;

      if (gameOver) {
        // Latch the position so subsequent frames dedup against it (instead of
        // classifying the same FEN as "intermediate", which caused the overlay
        // pill to flicker: the old code only emitted `game_over` on a single
        // frame per 800ms intermediate-release cycle). Stickying `lastGameOver`
        // ensures dedup / intermediate re-emissions carry the flag too.
        this.prevPositionFen = positionFen;
        this.lastPositionFen = positionFen;
        this.lastFullFen = fullFen;
        this.lastGameOver = gameOver;
        log(`Game over: ${gameOver}`);
        sendResult(makeResult({ game_over: gameOver }));
        return;
      }
      // Reaching here means the current position is NOT game-over — drop any
      // stale sticky flag from an earlier position.
      this.lastGameOver = undefined;

      t = Date.now();
      this.lastPlayedMove = null;
      let prevBestScore: number | null = null;
      if (this.lastFullFen && this.lastEval) {
        const seqMove = detectSequentialMove(this.lastFullFen, positionFen);
        if (seqMove) {
          const prevBest = this.lastEval.top_moves[0];
          prevBestScore = prevBest?.score_cp ?? null;
          const matchingMove = this.lastEval.top_moves.find(m => m.move === seqMove.uci);
          const lossCp = matchingMove ? matchingMove.loss_cp : null;
          this.lastPlayedMove = {
            from: seqMove.uci.slice(0, 2),
            to: seqMove.uci.slice(2, 4),
            uci: seqMove.uci,
            san: seqMove.san,
            // null = "eval hasn't resolved this move's quality yet". Renderers
            // skip the marker until this becomes a real number (otherwise a
            // coerced 0 would paint a false green-checkmark).
            loss_cp: lossCp,
          };
          if (lossCp !== null) {
            log(`Sequential move: ${seqMove.san} (${seqMove.uci}) loss=${lossCp}cp`);
          } else {
            log(`Sequential move: ${seqMove.san} (${seqMove.uci}) — not in top ${this.lastEval.top_moves.length}, loss pending`);
          }
        }
      }
      tSeqMove = Date.now() - t;

      const playedMoveLossFromTopMoves = this.lastPlayedMove
        ? this.lastEval?.top_moves.some(m => m.move === this.lastPlayedMove!.uci) ?? false
        : false;

      const updatePlayedMoveLoss = (evalResult: EvalResult): void => {
        if (!this.lastPlayedMove || prevBestScore === null || playedMoveLossFromTopMoves) return;
        const currBest = evalResult.top_moves[0]?.score_cp ?? 0;
        const loss = Math.max(0, prevBestScore + currBest);
        this.lastPlayedMove = { ...this.lastPlayedMove, loss_cp: loss };
        log(`Played move loss updated: ${this.lastPlayedMove.san} loss=${loss}cp (prev=${prevBestScore} curr=${currBest} d=${evalResult.depth})`);
      };

      this.prevPositionFen = positionFen;
      this.lastPositionFen = positionFen;
      this.lastFullFen = fullFen;
      const staleEval = this.lastEval;
      this.lastEval = null;
      this.lastArrows = [];

      if (this.evalAbortController) {
        this.evalAbortController.abort();
      }
      this.evalAbortController = new AbortController();
      const { signal } = this.evalAbortController;

      const cached = cacheGet(fullFen);
      if (cached) {
        updatePlayedMoveLoss(cached.evaluation);
        this.lastEval = cached.evaluation;
        this.lastDisplayEval = cached.evaluation;
        this.lastArrows = cached.arrows;
        const cachedDepth = cached.evaluation.depth;
        log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} fen=${tFenBuild}ms gameOver=${tGameOver}ms seqMove=${tSeqMove}ms [cache d=${cachedDepth}] total=${Date.now() - startTime}ms`);
        sendResult(makeResult({
          evaluation: cached.evaluation,
          arrows: cached.arrows,
          eval_depth: cachedDepth,
          eval_max_depth: cachedDepth < this.maxDepth ? this.maxDepth : undefined,
        }));

        if (cachedDepth < this.maxDepth) {
          let nextDepth = EVAL_START_DEPTH;
          while (nextDepth <= cachedDepth) nextDepth += EVAL_DEPTH_STEP;
          const cachedEvalPositionFen = positionFen;
          void (async () => {
            for (let depth = nextDepth; depth <= this.maxDepth; depth += EVAL_DEPTH_STEP) {
              if (signal.aborted) break;
              const currentEngine = this.deps.getEngine();
              if (!currentEngine) break;
              const result = await currentEngine.runDepth(fullFen, depth, this.multiPvForDepth(depth), signal);
              if (!result || signal.aborted) break;
              if (!result.top_moves[0]?.pv?.length) {
                log(`Engine returned empty PV at depth ${depth} — reinitializing`);
                await this.deps.reinitEngine();
                break;
              }
              if (this.lastPositionFen !== cachedEvalPositionFen) break;
              updatePlayedMoveLoss(result);
              const arrows = computeArrows(result.top_moves);
              this.lastEval = result;
              this.lastDisplayEval = result;
              this.lastArrows = arrows;
              cachePut(fullFen, { evaluation: result, arrows });
              log(`Eval depth ${result.depth}/${this.maxDepth} in ${result.elapsed_ms}ms score=${result.top_moves[0]?.score_cp}cp pv=${result.top_moves[0]?.pv?.slice(0, 4).join(' ')}`);
              sendResult(makeResult({
                evaluation: result,
                arrows,
                eval_depth: result.depth,
                eval_max_depth: result.depth < this.maxDepth ? this.maxDepth : undefined,
              }));
            }
          })();
        }
        return;
      }

      log(`Timing: detect=${tDetect}ms${detectSkipped ? '[skip]' : ''} crop+preview=${tPreview}ms chgdet=${tChangeDetect}ms ${recogDetail} fen=${tFenBuild}ms gameOver=${tGameOver}ms seqMove=${tSeqMove}ms [new pos] total=${Date.now() - startTime}ms`);
      // Prefer the just-reset lastEval (already null by now) → fall back to
      // lastDisplayEval, which survives back-to-back [new pos] frames so the
      // bar stays visible (transparent) instead of vanishing.
      const newPosStaleEval = staleEval ?? this.lastDisplayEval;
      sendResult(makeResult(newPosStaleEval
        ? { evaluation: newPosStaleEval, eval_depth: newPosStaleEval.depth, eval_max_depth: this.maxDepth, stale_eval: true }
        : { eval_max_depth: this.maxDepth, stale_eval: true }));

      const evalPositionFen = positionFen;
      void (async () => {
        for (let depth = EVAL_START_DEPTH; depth <= this.maxDepth; depth += EVAL_DEPTH_STEP) {
          if (signal.aborted) break;
          const currentEngine = this.deps.getEngine();
          if (!currentEngine) break;
          const result = await currentEngine.runDepth(fullFen, depth, this.multiPvForDepth(depth), signal);
          if (!result || signal.aborted) break;
          if (!result.top_moves[0]?.pv?.length) {
            log(`Engine returned empty PV at depth ${depth} — reinitializing`);
            await this.deps.reinitEngine();
            break;
          }
          if (this.lastPositionFen !== evalPositionFen) break;
          updatePlayedMoveLoss(result);
          const arrows = computeArrows(result.top_moves);
          this.lastEval = result;
          this.lastDisplayEval = result;
          this.lastArrows = arrows;
          cachePut(fullFen, { evaluation: result, arrows });
          log(`Eval depth ${result.depth}/${this.maxDepth} in ${result.elapsed_ms}ms score=${result.top_moves[0]?.score_cp}cp pv=${result.top_moves[0]?.pv?.slice(0, 4).join(' ')}`);
          sendResult(makeResult({
            evaluation: result,
            arrows,
            eval_depth: result.depth,
            eval_max_depth: result.depth < this.maxDepth ? this.maxDepth : undefined,
          }));
        }
      })();
    } catch (err) {
      log(`Frame processing error: ${err}`);
    }
  }
}
