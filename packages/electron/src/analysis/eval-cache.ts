import type { EvalResult, ArrowDescriptor } from '@chessray/core';

export const EVAL_START_DEPTH = 12;
export const EVAL_DEPTH_STEP = 4;
export const EVAL_MAX_DEPTH = 28;
export const EVAL_MULTI_PV_START = 2;
export const EVAL_MULTI_PV_MAX = 5;
export const EVAL_MULTI_PV_RAMP = 1; // depth steps per additional line

// Mutable runtime overrides (set via IPC from UI)
export let multiPvMax = EVAL_MULTI_PV_MAX;
export let multiPvRamp = EVAL_MULTI_PV_RAMP;

export function setMultiPvMax(n: number): void { multiPvMax = n; }
export function setMultiPvRamp(n: number): void { multiPvRamp = n; }

/** Return multiPV count for a given search depth — ramp from start to max */
export function multiPvForDepth(depth: number): number {
  const steps = Math.floor((depth - EVAL_START_DEPTH) / EVAL_DEPTH_STEP);
  const linesFromRamp = multiPvRamp > 0 ? Math.floor(steps / multiPvRamp) : steps;
  return Math.min(multiPvMax, EVAL_MULTI_PV_START + linesFromRamp);
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
