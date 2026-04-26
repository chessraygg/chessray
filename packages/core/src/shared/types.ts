// Lifted from packages/electron/src/shared/types.ts so the analysis runtime
// + overlay UI can be shared between Electron and the Chrome extension.
// All host-agnostic — talks only about pipeline/eval shapes.

import type {
  BoardBBox,
  RecognitionResult,
  EvalResult,
  Turn,
} from '../types.js';
import type { OrientationSource } from '../orientation/orientation.js';
import type { DisambiguationTraceCorrected } from '../pipeline/recognize-board.js';

/** Detected end-of-game state */
export type GameOver = 'checkmate' | 'stalemate';

/** Descriptor for a single arrow to be drawn on the board */
export interface ArrowDescriptor {
  from: string; // algebraic square e.g., "e2"
  to: string; // algebraic square e.g., "e4"
  color: string; // hex color
  width: number; // stroke width in pixels
  opacity: number; // 0-1
  loss_cp: number; // centipawn loss (0 for best move)
  label?: string; // optional label drawn at arrow start (e.g. move number)
}

/** Full pipeline result for IPC between analysis renderer and overlay renderer */
export interface PipelineResult {
  board_detection: {
    found: boolean;
    bbox: BoardBBox | null;
    confidence: number;
  };
  recognition: RecognitionResult | null;
  evaluation: EvalResult | null;
  eval_depth?: number; // current completed depth
  eval_max_depth?: number; // target max depth (shows "calculating..." if eval_depth < eval_max_depth)
  stale_eval?: boolean; // true when eval is from previous position (kept for visual continuity)
  arrows: ArrowDescriptor[];
  highlighted_squares?: number[]; // indices of highlighted squares (0-63, corrected orientation)
  flipped?: boolean; // true = board is flipped (white at top in video)
  turn?: Turn; // whose turn it is (from highlight detection)
  game_over?: GameOver; // detected end-of-game state
  orientation_source?: OrientationSource; // how orientation was detected
  played_move?: {
    from: string;    // algebraic square (source)
    to: string;      // algebraic square (destination)
    uci: string;     // full UCI string (includes promotion piece)
    san: string;     // SAN notation for display
    /** Centipawn loss vs the previous position's best move. `null` means the
     *  move was detected but its quality isn't known yet (eval still running,
     *  or move not in top_moves). Renderers should skip the quality badge
     *  until this resolves to a number rather than defaulting to 0 (which
     *  would falsely paint a green-checkmark "excellent" marker). */
    loss_cp: number | null;
  } | null;
  detection_status?: string; // human-readable detection status for debug display
  board_image_url?: string; // data URL of the cropped board for debug display
  frame_dimensions?: { width: number; height: number }; // capture frame size for coordinate mapping
  /** Median RGB color of the board's light and dark squares, sampled from the
   * inner 6x6 squares. Useful for theming overlays/analysis boards to match. */
  square_colors?: { light: [number, number, number]; dark: [number, number, number] };
  /** Detailed highlight-detection breakdown for the debug panel (no effect on rendering). */
  highlight_debug?: {
    /** Raw above-threshold candidates in corrected orientation, sorted by score desc. */
    candidates: Array<{ square: string; score: number; piece: string | null }>;
    medians: { light: [number, number, number]; dark: [number, number, number] };
    disambiguation: DisambiguationTraceCorrected;
    invalidHighlights: boolean;
    midAnimation: boolean;
    timing: { highlights_ms: number; disambiguate_ms: number };
  };
  /** Per-stage timings for the full frame loop. All values are milliseconds. */
  frame_timing?: {
    /** drawImage + getImageData in the capture interval. */
    capture_ms: number;
    /** Cheap fingerprint sample of the frame outside the cached bbox. */
    fingerprint_ms: number;
    /** YOLO board detection. 0 when skipped (cached bbox + frame unchanged). */
    detect_ms: number;
    detect_skipped: boolean;
    /** Cropping the board region. */
    crop_ms: number;
    /** JPEG/dataURL encoding for the debug preview (0 in tests). */
    preview_ms: number;
    /** Sampling cropped board pixels for change detection. */
    change_detect_ms: number;
    /** Total recognition wall time (covers the breakdown below). */
    recog_ms: number;
    /** True when recognition was reused from a previous frame (visuallyUnchanged
     *  fast path). Auto-tune ignores cached frames as a signal to step UP
     *  because they don't exercise the real pipeline cost. */
    recog_cached: boolean;
    /** Recognition sub-stage breakdown. Null when recognition was cached/skipped. */
    recog_breakdown: {
      yolo_prep_ms: number;
      yolo_infer_ms: number;
      yolo_post_ms: number;
      pieces_ms: number;
      orientation_ms: number;
      highlights_ms: number;
      disambiguate_ms: number;
      turn_ms: number;
    } | null;
    /** Building the full FEN string. */
    fen_build_ms: number;
    /** Detecting checkmate/stalemate. */
    game_over_ms: number;
    /** Detecting a sequential move from previous position. */
    seq_move_ms: number;
    /** Sum of pipeline work in processFrame. */
    pipeline_ms: number;
    /** Wall-clock when the captured frame was sent over IPC (Date.now). */
    sent_at: number;
    /** Last completed eval depth's elapsed_ms (async, not part of pipeline_ms). */
    eval_ms?: number;
    eval_depth?: number;
    /** IPC delivery time, computed in the overlay (received_at - sent_at). */
    ipc_ms?: number;
    /** DOM/render time of the previous frame, computed in the overlay. */
    render_ms?: number;
  };
  total_elapsed_ms: number;
}
