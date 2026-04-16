import type { BoardBBox, RecognitionResult, EvalResult } from '@chessray/core';

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
  turn?: 'w' | 'b'; // whose turn it is (from highlight detection)
  game_over?: 'checkmate' | 'stalemate'; // detected end-of-game state
  orientation_source?: 'label' | 'pawn_move' | 'piece_count'; // how orientation was detected
  played_move?: {
    from: string;    // algebraic square (source)
    to: string;      // algebraic square (destination)
    uci: string;     // full UCI string (includes promotion piece)
    san: string;     // SAN notation for display
    loss_cp: number; // centipawn loss vs best move from previous eval
  } | null;
  detection_status?: string; // human-readable detection status for debug display
  board_image_url?: string; // data URL of the cropped board for debug display
  frame_dimensions?: { width: number; height: number }; // capture frame size for coordinate mapping
  total_elapsed_ms: number;
}
