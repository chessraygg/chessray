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

