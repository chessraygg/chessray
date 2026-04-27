import type { EvalResult, EvalMove } from '../types.js';
import { parseInfoLine, parseBestMove } from './stockfish-uci-parser.js';

/** Minimal engine interface used by the frame pipeline. Implemented by `StockfishEngine`
 *  and by test stubs. Keep it narrow — extending is a deliberate decision. */
export interface EvalEngine {
  /** Run a single-depth search. Returns null if aborted before any result. */
  runDepth(
    fen: string,
    depth: number,
    multiPV: number,
    signal?: AbortSignal,
  ): Promise<EvalResult | null>;
  /** Tell the engine the next position is from a fresh game.
   *  Sends `ucinewgame` + waits `readyok` so Stockfish flushes per-game
   *  state (transposition entries from unrelated previous positions
   *  that gradually pollute the hash and slow successive searches).
   *  Optional in the interface — test stubs can omit it. */
  newGame?(): Promise<void>;
}

export interface StockfishOptions {
  depth?: number;
  multiPV?: number;
}

export interface IterativeEvalOptions {
  startDepth: number;
  maxDepth: number;
  depthStep: number;
  multiPV?: number;
  signal?: AbortSignal;
  onDepth?: (result: EvalResult) => void;
}

/**
 * Browser-first Stockfish wrapper.
 * Runs stockfish.wasm in a Web Worker via postMessage/onmessage.
 */
export class StockfishEngine {
  private worker: Worker | null = null;
  private ready = false;
  private defaultDepth: number;
  private defaultMultiPV: number;
  private messageHandler: ((line: string) => void) | null = null;
  private busyPromise: Promise<void> = Promise.resolve(); // serializes Stockfish access

  constructor(options: StockfishOptions = {}) {
    this.defaultDepth = options.depth ?? 20;
    this.defaultMultiPV = options.multiPV ?? 3;
  }

  /**
   * Initialize by creating a Web Worker from the stockfish.js file.
   * @param workerUrl - URL to stockfish.js (use chrome.runtime.getURL in extensions)
   */
  async init(workerUrl: string): Promise<void> {
    this.worker = new Worker(workerUrl);

    return new Promise<void>((resolve) => {
      this.worker!.onmessage = (e: MessageEvent) => {
        const line = String(e.data);

        if (line.includes('uciok')) {
          this.send(`setoption name MultiPV value ${this.defaultMultiPV}`);
          this.send('isready');
        }
        if (line.includes('readyok')) {
          this.ready = true;
          resolve();
        }

        // Forward to current handler
        if (this.messageHandler) {
          this.messageHandler(line);
        }
      };

      this.send('uci');
    });
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  async evaluate(fen: string, options?: { depth?: number; multiPV?: number }): Promise<EvalResult> {
    if (!this.worker || !this.ready) {
      throw new Error('Stockfish not initialized. Call init() first.');
    }

    const depth = options?.depth ?? this.defaultDepth;
    const multiPV = options?.multiPV ?? this.defaultMultiPV;
    const startTime = Date.now();

    if (multiPV !== this.defaultMultiPV) {
      this.send(`setoption name MultiPV value ${multiPV}`);
    }

    return new Promise<EvalResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.messageHandler = null;
        reject(new Error(`Stockfish eval timed out after 10s for FEN: ${fen}`));
      }, 10000);

      const infoByPV = new Map<number, { scoreCp: number; pv: string[]; depth: number }>();

      this.messageHandler = (line: string) => {
        const info = parseInfoLine(line);
        if (info && info.depth === depth) {
          infoByPV.set(info.multipv, {
            scoreCp: info.scoreCp,
            pv: info.pv,
            depth: info.depth,
          });
        }

        const best = parseBestMove(line);
        if (best) {
          const topMoves: EvalMove[] = [];
          const bestScore = infoByPV.get(1)?.scoreCp ?? 0;

          for (let i = 1; i <= multiPV; i++) {
            const pvInfo = infoByPV.get(i);
            if (pvInfo) {
              topMoves.push({
                move: pvInfo.pv[0],
                score_cp: pvInfo.scoreCp,
                loss_cp: bestScore - pvInfo.scoreCp,
                pv: pvInfo.pv,
              });
            }
          }

          if (multiPV !== this.defaultMultiPV) {
            this.send(`setoption name MultiPV value ${this.defaultMultiPV}`);
          }

          clearTimeout(timeout);
          this.messageHandler = null;
          resolve({
            fen,
            depth,
            top_moves: topMoves,
            elapsed_ms: Date.now() - startTime,
          });
        }
      };

      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  /**
   * Iterative deepening evaluation. Runs Stockfish at increasing depths,
   * calling onDepth with results at each milestone. Abortable via signal.
   *
   * When aborted, sends 'stop' to Stockfish and waits for 'bestmove' before
   * returning — guaranteeing Stockfish is idle for the next call.
   *
   * Returns the deepest result achieved, or null if aborted before any depth.
   */
  async evaluateIterative(fen: string, options: IterativeEvalOptions): Promise<EvalResult | null> {
    if (!this.worker || !this.ready) {
      throw new Error('Stockfish not initialized. Call init() first.');
    }

    const { startDepth, maxDepth, depthStep, signal, onDepth } = options;
    const multiPV = options.multiPV ?? this.defaultMultiPV;

    if (multiPV !== this.defaultMultiPV) {
      this.send(`setoption name MultiPV value ${multiPV}`);
    }

    let lastResult: EvalResult | null = null;

    for (let depth = startDepth; depth <= maxDepth; depth += depthStep) {
      if (signal?.aborted) break;

      const result = await this.runDepth(fen, depth, multiPV, signal);
      // result is null if aborted mid-search (Stockfish is now idle)
      if (result === null) break;

      lastResult = result;
      onDepth?.(result);
    }

    if (multiPV !== this.defaultMultiPV) {
      this.send(`setoption name MultiPV value ${this.defaultMultiPV}`);
    }

    return lastResult;
  }

  /**
   * Run a single depth search. Serialized — waits for any previous search
   * to finish before starting. If signal fires during search, sends 'stop'
   * and waits for bestmove before returning null.
   */
  runDepth(
    fen: string,
    depth: number,
    multiPV: number,
    signal?: AbortSignal,
  ): Promise<EvalResult | null> {
    const run = this.busyPromise.then(() => {
      if (signal?.aborted) return null;
      return this.doSearch(fen, depth, multiPV, signal);
    });
    // Chain: next runDepth waits for this one to fully complete
    this.busyPromise = run.then(() => {});
    return run;
  }

  private doSearch(
    fen: string,
    depth: number,
    multiPV: number,
    signal?: AbortSignal,
  ): Promise<EvalResult | null> {
    return new Promise<EvalResult | null>((resolve) => {
      // Keep the engine's MultiPV in sync with the caller's request. Without
      // this, direct runDepth() callers (bypassing run()) get the defaultMultiPV
      // set during UCI init — so ramp-up past the starting N silently returns
      // fewer PV lines than requested.
      if (multiPV !== this.defaultMultiPV) {
        this.send(`setoption name MultiPV value ${multiPV}`);
        this.defaultMultiPV = multiPV;
      }
      const startTime = Date.now();
      // Safety timeout: 5 minutes. Normal cancellation uses AbortSignal.
      const timeout = setTimeout(() => {
        this.messageHandler = null;
        resolve(null);
      }, 300000);

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        this.send('stop');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const infoByPV = new Map<number, { scoreCp: number; pv: string[]; depth: number }>();

      this.messageHandler = (line: string) => {
        const info = parseInfoLine(line);
        if (info && info.depth === depth) {
          infoByPV.set(info.multipv, {
            scoreCp: info.scoreCp,
            pv: info.pv,
            depth: info.depth,
          });
        }

        const best = parseBestMove(line);
        if (best) {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
          this.messageHandler = null;

          if (aborted || signal?.aborted) {
            resolve(null);
            return;
          }

          const topMoves: EvalMove[] = [];
          const bestScore = infoByPV.get(1)?.scoreCp ?? 0;

          for (let i = 1; i <= multiPV; i++) {
            const pvInfo = infoByPV.get(i);
            if (pvInfo) {
              topMoves.push({
                move: pvInfo.pv[0],
                score_cp: pvInfo.scoreCp,
                loss_cp: bestScore - pvInfo.scoreCp,
                pv: pvInfo.pv,
              });
            }
          }

          resolve({
            fen,
            depth: infoByPV.get(1)?.depth ?? depth,
            top_moves: topMoves,
            elapsed_ms: Date.now() - startTime,
          });
        }
      };

      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  stop(): void {
    this.send('stop');
  }

  /** UCI 'ucinewgame' + sync via 'isready'. Serialized through the
   *  same busyPromise chain as runDepth so it can't interleave with an
   *  in-flight search. Call between unrelated positions to keep the
   *  transposition table from polluting successive searches over a
   *  long live-analysis session. */
  newGame(): Promise<void> {
    const run = this.busyPromise.then(() => this.doNewGame());
    this.busyPromise = run.then(() => {}, () => {});
    return run;
  }

  private doNewGame(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.worker || !this.ready) {
        reject(new Error('Stockfish not initialized'));
        return;
      }
      const timeout = setTimeout(() => {
        this.messageHandler = null;
        reject(new Error('newGame timed out'));
      }, 5000);
      this.messageHandler = (line: string) => {
        if (line.includes('readyok')) {
          clearTimeout(timeout);
          this.messageHandler = null;
          resolve();
        }
      };
      this.send('ucinewgame');
      this.send('isready');
    });
  }

  destroy(): void {
    this.send('quit');
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }
}
