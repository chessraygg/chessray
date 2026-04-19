/**
 * Slow-frame history — persisted ring buffer of frames whose end-to-end time
 * exceeded the FPS budget (1000 / targetFps). Survives app restart via
 * localStorage so the user can inspect what slowed past sessions.
 */
import type { PipelineResult } from '../shared/types.js';

const STORAGE_KEY = 'chessray-debug-history-v1';
export const MAX_ENTRIES = 10;

/** Stored snapshot — subset of PipelineResult sufficient to re-render the
 *  Debug section as it appeared when the slow frame happened. Large/derived
 *  fields (arrows, evaluation top_moves, etc.) are omitted to keep
 *  localStorage usage modest. */
export interface DebugSnapshot {
  id: number;
  /** Date.now() when the frame was processed. */
  captured_at: number;
  /** End-to-end ms (capture + pipeline + ipc + render). */
  total_ms: number;
  /** Per-frame FPS budget in ms (1000 / targetFps). */
  budget_ms: number;
  /** Snapshot of fields the debug panel renders. */
  result: Pick<
    PipelineResult,
    | 'recognition'
    | 'evaluation'
    | 'highlighted_squares'
    | 'flipped'
    | 'turn'
    | 'orientation_source'
    | 'detection_status'
    | 'board_image_url'
    | 'square_colors'
    | 'highlight_debug'
    | 'frame_timing'
    | 'total_elapsed_ms'
    | 'game_over'
    | 'eval_depth'
    | 'eval_max_depth'
  >;
}

let nextId = 1;

export function loadHistory(): DebugSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as DebugSnapshot[];
    if (!Array.isArray(arr)) return [];
    if (arr.length > 0) nextId = Math.max(...arr.map(e => e.id)) + 1;
    return arr;
  } catch { return []; }
}

function saveHistory(entries: DebugSnapshot[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (err) {
    // Likely quota exceeded — drop oldest until the write succeeds.
    let trimmed = [...entries];
    while (trimmed.length > 1) {
      trimmed = trimmed.slice(1);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed)); return; } catch { /* keep trimming */ }
    }
    console.warn('[chessray] debug-history: failed to persist', err);
  }
}

/** Append a slow-frame snapshot, evicting oldest when exceeding MAX_ENTRIES. */
export function pushSlowFrame(
  current: DebugSnapshot[],
  result: PipelineResult,
  totalMs: number,
  budgetMs: number,
): DebugSnapshot[] {
  const snapshot: DebugSnapshot = {
    id: nextId++,
    captured_at: Date.now(),
    total_ms: totalMs,
    budget_ms: budgetMs,
    result: {
      recognition: result.recognition,
      evaluation: result.evaluation,
      highlighted_squares: result.highlighted_squares,
      flipped: result.flipped,
      turn: result.turn,
      orientation_source: result.orientation_source,
      detection_status: result.detection_status,
      board_image_url: result.board_image_url,
      square_colors: result.square_colors,
      highlight_debug: result.highlight_debug,
      frame_timing: result.frame_timing,
      total_elapsed_ms: result.total_elapsed_ms,
      game_over: result.game_over,
      eval_depth: result.eval_depth,
      eval_max_depth: result.eval_max_depth,
    },
  };
  const next = [...current, snapshot].slice(-MAX_ENTRIES);
  saveHistory(next);
  return next;
}

export function clearHistory(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Reconstruct a PipelineResult shape from a snapshot for re-rendering.
 *  Fills required-but-missing fields with safe defaults so updateDebugPanel
 *  can be called with the same signature it uses for live results. */
export function snapshotToResult(s: DebugSnapshot): PipelineResult {
  return {
    board_detection: { found: true, bbox: null, confidence: s.result.recognition?.confidence ?? 0 },
    arrows: [],
    ...s.result,
  } as PipelineResult;
}
