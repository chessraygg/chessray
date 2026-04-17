import type { EvalEngine, EvalResult } from '@chessray/core';

/** No-op engine for tests. Returns an empty eval instantly so the frame
 *  pipeline treats every accepted frame as "engine queued but produced no
 *  results yet" — enough to exercise recognition / highlights / state
 *  tracking without Stockfish's weight and nondeterminism. */
export class StubEngine implements EvalEngine {
  async runDepth(fen: string, depth: number): Promise<EvalResult | null> {
    return {
      fen,
      depth,
      top_moves: [],
      elapsed_ms: 0,
    };
  }
}
