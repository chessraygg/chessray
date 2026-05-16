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
 *  Smoothed via N-sample hysteresis on the bump-up side; the drop side is
 *  also enforced by a hard timeout in the caller (FIRST_EVAL_TIMEOUT_MS), so
 *  a slow first eval is killed at 500ms and immediately drops the depth
 *  without waiting for hysteresis. */
const START_TARGET_MIN_MS = 300;
const START_TARGET_MAX_MS = 500;
const START_DEPTH_FLOOR = 12;
const START_DEPTH_CEILING = 30;
const START_HYSTERESIS_N = 2;
/** Hard cap on the cold-start eval. The frame-processor wraps the first-depth
 *  runDepth in an AbortController that fires at this deadline; on timeout it
 *  calls recordStartEvalDuration with hardTimeout=true to force-drop the
 *  start depth (bypassing hysteresis) and retries at the new lower depth. */
export const FIRST_EVAL_TIMEOUT_MS = START_TARGET_MAX_MS;

let currentStartDepth = EVAL_START_DEPTH;
let consecutiveFast = 0;
let consecutiveSlow = 0;

export function evalStartDepth(): number { return currentStartDepth; }

export function recordStartEvalDuration(
  elapsedMs: number,
  aborted: boolean,
  hardTimeout = false,
): void {
  // hardTimeout: the search was killed by the caller's FIRST_EVAL_TIMEOUT_MS
  // deadline. One sample is enough — bypass hysteresis and drop the start
  // depth immediately. Without this, the retry loop at the same depth would
  // burn another full timeout window before progress.
  if (hardTimeout) {
    currentStartDepth = Math.max(currentStartDepth - EVAL_DEPTH_STEP, START_DEPTH_FLOOR);
    consecutiveFast = 0;
    consecutiveSlow = 0;
    return;
  }

  // Asymmetric exclusion: slow elapsed_ms is real evidence the depth is too
  // costly even when aborted (engine was grinding regardless). Short / in-
  // window samples from aborted runs are unreliable (the search may have been
  // cut short before doing real work), so we exclude those. Mostly dormant
  // under the hard timeout, but kept as a safety net if the timeout is raised.
  const isSlow = elapsedMs > START_TARGET_MAX_MS;
  if (aborted && !isSlow) return;

  if (isSlow) {
    consecutiveSlow += 1;
    consecutiveFast = 0;
    if (consecutiveSlow >= START_HYSTERESIS_N) {
      currentStartDepth = Math.max(currentStartDepth - EVAL_DEPTH_STEP, START_DEPTH_FLOOR);
      consecutiveSlow = 0;
    }
  } else if (elapsedMs < START_TARGET_MIN_MS) {
    consecutiveFast += 1;
    consecutiveSlow = 0;
    if (consecutiveFast >= START_HYSTERESIS_N) {
      currentStartDepth = Math.min(currentStartDepth + EVAL_DEPTH_STEP, START_DEPTH_CEILING);
      consecutiveFast = 0;
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
