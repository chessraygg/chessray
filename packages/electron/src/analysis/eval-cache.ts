import type { EvalResult, ArrowDescriptor } from '@chessray/core';

export const EVAL_START_DEPTH = 12;
export const EVAL_DEPTH_STEP = 4;
export const EVAL_MAX_DEPTH = 28;
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
