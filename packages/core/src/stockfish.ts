import type { EvalResult, EvalMove } from './types.js';
import { parseInfoLine, parseBestMove } from './stockfish-uci-parser.js';

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

  constructor(private options: StockfishOptions = {}) {
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

  destroy(): void {
    this.send('quit');
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }
}
