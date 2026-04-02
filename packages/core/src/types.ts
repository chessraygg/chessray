/** Bounding box of a detected chessboard in pixel coordinates */
export interface BoardBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-tile classification result */
export interface TileClassification {
  square: string; // e.g., "a1", "h8"
  piece: string; // 'p','n','b','r','q','k','P','N','B','R','Q','K','.' (empty)
  confidence: number;
}

/** Result of running piece recognition on a board image */
export interface RecognitionResult {
  fen: string;
  confidence: number;
  tiles: TileClassification[];
  elapsed_ms: number;
  timing?: { prep_ms: number; infer_ms: number; post_ms: number };
}

/** A single evaluated move from Stockfish */
export interface EvalMove {
  move: string; // UCI format e.g., "e2e4"
  score_cp: number; // centipawns from side-to-move perspective
  loss_cp: number; // centipawn loss vs best move (best = 0)
  pv: string[]; // principal variation
}

/** Result of Stockfish evaluation */
export interface EvalResult {
  fen: string;
  depth: number;
  top_moves: EvalMove[];
  elapsed_ms: number;
}

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

/** Full pipeline result combining all stages */
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
  arrows: ArrowDescriptor[];
  highlighted_squares?: number[]; // indices of highlighted squares (0-63, corrected orientation)
  flipped?: boolean; // true = board is flipped (white at top in video)
  orientation_source?: 'label' | 'pawn_move' | 'piece_count'; // how orientation was detected
  board_image_url?: string; // data URL of the cropped board for debug display
  frame_dimensions?: { width: number; height: number }; // capture frame size for coordinate mapping
  total_elapsed_ms: number;
}

/** Extension runtime state */
export type ExtensionState = 'idle' | 'capturing' | 'analyzing' | 'displaying';

/** Message types for Chrome extension messaging */
export type Message =
  | { type: 'START_TRACKING' }
  | { type: 'STOP_TRACKING' }
  | { type: 'FRAME_DATA'; payload: { imageData: ArrayBuffer; width: number; height: number } }
  | { type: 'FRAME_RESULT'; payload: PipelineResult }
  | { type: 'GET_STATE' }
  | { type: 'STATE_UPDATE'; payload: { state: ExtensionState; fen?: string; eval?: EvalResult; arrows?: ArrowDescriptor[] } }
  | { type: 'DEBUG_LOG'; payload: string }
  | { type: 'HIDE_OVERLAY' }
  | { type: 'SHOW_OVERLAY' };
