import type { EvalResult } from '@chessray/core';
import type { ArrowDescriptor } from '../shared/types.js';

export const EVAL_START_DEPTH = 16;
export const EVAL_DEPTH_STEP = 4;
export const EVAL_MAX_DEPTH = 28;
/** Line count for the very first (shallowest) eval pass. Capped by the user's
 *  selected max below. Kept small so the initial preview arrives quickly. */
export const EVAL_MULTI_PV_START = 3;
export const EVAL_MULTI_PV_MAX = 5;

// Mutable runtime overrides (set via IPC from UI)
export let multiPvMax = EVAL_MULTI_PV_MAX;

export function setMultiPvMax(n: number): void { multiPvMax = n; }

/** Return multiPV count for a given search depth. First pass gets a small
 *  quick-look count (EVAL_MULTI_PV_START, capped to user's max); every deeper
 *  pass gets the user's full selected max. No ramp. */
export function multiPvForDepth(depth: number): number {
  if (depth === EVAL_START_DEPTH) return Math.min(EVAL_MULTI_PV_START, multiPvMax);
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
