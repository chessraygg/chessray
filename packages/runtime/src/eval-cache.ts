import type { EvalResult } from '@chessray/core';
import type { ArrowDescriptor } from '@chessray/core';

/** Initial seed for the dynamic start depth. The runtime value drifts in
 *  evalStartDepth() based on observed cold-start eval timing. Read the
 *  function, not this constant, when selecting the first search depth for a
 *  fresh position. */
export const EVAL_START_DEPTH = 20;
export const EVAL_DEPTH_STEP = 4;
/** Effectively unbounded — the iterative-deepening loop keeps going until the
 *  position changes (AbortController fires from frame-processor) or the engine
 *  saturates. Stockfish 18-lite plateaus well before depth 99 in practice. */
export const EVAL_MAX_DEPTH = 99;
/** Line count for the very first (shallowest) eval pass. Capped by the user's
 *  selected max below. Kept small so the initial preview arrives quickly. */
export const EVAL_MULTI_PV_START = 3;
export const EVAL_MULTI_PV_MAX = 5;

/** Dynamic start-depth adapter — drifts the start depth based on observed
 *  wall time of the cold-start eval, like an adaptive frame-rate controller.
 *  Smoothed via N-sample hysteresis so a single slow tactical position doesn't
 *  bounce the depth. Cached and aborted evals are excluded by the caller. */
const START_TARGET_MIN_MS = 300;
const START_TARGET_MAX_MS = 800;
const START_DEPTH_FLOOR = 12;
const START_DEPTH_CEILING = 30;
const START_HYSTERESIS_N = 2;

let currentStartDepth = EVAL_START_DEPTH;
let consecutiveFast = 0;
let consecutiveSlow = 0;

export function evalStartDepth(): number { return currentStartDepth; }

export function recordStartEvalDuration(elapsedMs: number, aborted: boolean): void {
  if (aborted) return;
  if (elapsedMs < START_TARGET_MIN_MS) {
    consecutiveFast += 1;
    consecutiveSlow = 0;
    if (consecutiveFast >= START_HYSTERESIS_N) {
      currentStartDepth = Math.min(currentStartDepth + EVAL_DEPTH_STEP, START_DEPTH_CEILING);
      consecutiveFast = 0;
    }
  } else if (elapsedMs > START_TARGET_MAX_MS) {
    consecutiveSlow += 1;
    consecutiveFast = 0;
    if (consecutiveSlow >= START_HYSTERESIS_N) {
      currentStartDepth = Math.max(currentStartDepth - EVAL_DEPTH_STEP, START_DEPTH_FLOOR);
      consecutiveSlow = 0;
    }
  } else {
    consecutiveFast = 0;
    consecutiveSlow = 0;
  }
}

// Mutable runtime overrides (set via IPC from UI)
export let multiPvMax = EVAL_MULTI_PV_MAX;

export function setMultiPvMax(n: number): void { multiPvMax = n; }

/** First (cold-start) depth probed for a position gets the small quick-look
 *  multiPV count; every deeper pass gets the user's selected max. Caller
 *  passes whether this is the first depth — start depth is dynamic, so we no
 *  longer compare to a constant. */
export function multiPvForDepth(isFirstDepth: boolean): number {
  if (isFirstDepth) return Math.min(EVAL_MULTI_PV_START, multiPvMax);
  return multiPvMax;
}
export const EVAL_CACHE_SIZE = 32;
export const ENGINE_ID = 'stockfish-18-lite-single';

export interface CachedEval { evaluation: EvalResult; arrows: ArrowDescriptor[] }
export const evalCache = new Map<string, CachedEval>();

export function cacheKey(fen: string): string {
  return `${ENGINE_ID}:${fen}`;
}

export function cacheGet(fen: string): CachedEval | undefined {
  const key = cacheKey(fen);
  const entry = evalCache.get(key);
  if (entry) {
    evalCache.delete(key);
    evalCache.set(key, entry);
  }
  return entry;
}

export function cachePut(fen: string, entry: CachedEval): void {
  const key = cacheKey(fen);
  evalCache.delete(key);
  evalCache.set(key, entry);
  if (evalCache.size > EVAL_CACHE_SIZE) {
    const oldest = evalCache.keys().next().value!;
    evalCache.delete(oldest);
  }
}
