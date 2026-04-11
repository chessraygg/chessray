import type { RecognitionResult } from './types.js';
import type { PixelBuffer } from './pixel-utils.js';
import { detectHighlightedSquares, disambiguateHighlights, turnFromHighlight } from './highlight.js';
import { detectBoardFlipped, type OrientationSource } from './orientation.js';
import { flipFen, buildFullFen, fenSimilarity } from './fen.js';
import type { OrientationResult } from './image-utils.js';
import { detectLabels } from './label-detect.js';

export interface BoardRecognitionResult {
  /** FEN as read from raw image (before orientation correction) */
  rawFen: string;
  /** FEN after orientation correction (flipped if needed) */
  correctedFen: string;
  /** Full 6-field FEN with turn, castling, etc. Null if turn couldn't be determined. */
  fullFen: string | null;
  /** Recognition result with corrected FEN */
  recognition: RecognitionResult;
  /** Highlighted square indices in corrected orientation (0-63) */
  highlightedSquares: number[];
  /** Whether the board image is flipped (black at bottom in raw image) */
  flipped: boolean;
  /** Turn determined from highlights, or null if not determinable */
  turn: 'w' | 'b' | null;
  /** How orientation was detected */
  orientationSource: OrientationSource;
  /** True when highlights indicate a move but the piece hasn't landed yet (mid-animation) */
  midAnimation: boolean;
  /** Per-step timing breakdown (ms) */
  timing: {
    pieces_ms: number;
    orientation_ms: number;
    highlights_ms: number;
    disambiguate_ms: number;
    pawnRefine_ms: number;
    turn_ms: number;
    total_ms: number;
  };
}

/**
 * Complete board recognition pipeline: cropped board image → position, highlights, orientation, turn.
 *
 * Pure function with no state. Callers handle frame-level concerns (caching, dedup, eval, arrows)
 * and supply a fallback turn (e.g. guessTurn) when result.turn is null.
 */
export async function recognizeBoard(
  cropped: PixelBuffer,
  recognizer: { recognize(imageData: ImageData): Promise<RecognitionResult> },
  cachedOrientation?: { prevFen: string; orientation: OrientationResult } | null,
): Promise<BoardRecognitionResult> {
  const t0 = Date.now();

  // Step 1: Recognize pieces
  const recognition = await recognizer.recognize(cropped as unknown as ImageData);
  const rawFen = recognition.fen;
  const tPieces = Date.now() - t0;

  // Step 2: Detect orientation (before highlights — disambiguation needs flip info)
  // Use cached orientation when the position is similar to the previous one
  // (same game, just a few moves played). Only re-detect when the board
  // changes significantly (new game, different stream).
  let t = Date.now();
  const pieceCount = rawFen.replace(/[0-8/]/g, '').length;
  let orientation: OrientationResult;
  const similarity = cachedOrientation ? fenSimilarity(cachedOrientation.prevFen, rawFen) : 0;
  if (cachedOrientation && similarity > 0.5) {
    orientation = cachedOrientation.orientation;
  } else if (pieceCount >= 20) {
    orientation = detectBoardFlipped(rawFen);
  } else {
    const labelResult = await detectLabels(cropped);
    orientation = labelResult ?? detectBoardFlipped(rawFen);
  }
  const tOrientation = Date.now() - t;

  // Step 3: Detect highlights
  t = Date.now();
  const hlResult = detectHighlightedSquares(cropped);
  const tHighlights = Date.now() - t;

  // Step 3b: Disambiguate highlights
  t = Date.now();
  let highlightedSquares = disambiguateHighlights(hlResult.highlighted, rawFen, hlResult.scores, hlResult.colors, hlResult.medians, orientation.flipped);
  const tDisambiguate = Date.now() - t;

  // Step 4: Refine orientation using pawn move direction from highlights.
  // Only needed for sparse positions (<20 pieces) where piece_count heuristic
  // can be wrong. With 20+ pieces, piece_count is reliable.
  t = Date.now();
  if (pieceCount < 20 && highlightedSquares.length === 2) {
    const fenRows = rawFen.split('/');
    const fenBoard: (string | null)[] = new Array(64).fill(null);
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of fenRows[r]) {
        if (ch >= '1' && ch <= '8') f += parseInt(ch);
        else { fenBoard[r * 8 + f] = ch; f++; }
      }
    }
    const [idx0, idx1] = highlightedSquares;
    const p0 = fenBoard[idx0];
    const p1 = fenBoard[idx1];
    let pawn: string | null = null;
    let fromRow = -1, toRow = -1;
    if (p0 && (p0 === 'P' || p0 === 'p') && !p1) {
      pawn = p0; toRow = Math.floor(idx0 / 8); fromRow = Math.floor(idx1 / 8);
    } else if (p1 && (p1 === 'P' || p1 === 'p') && !p0) {
      pawn = p1; toRow = Math.floor(idx1 / 8); fromRow = Math.floor(idx0 / 8);
    }
    if (pawn && fromRow !== toRow) {
      const movedDown = toRow > fromRow;
      const pawnFlipped = pawn === 'P' ? movedDown : !movedDown;
      if (pawnFlipped !== orientation.flipped) {
        orientation = { flipped: pawnFlipped, source: 'pawn_move' };
      }
    }
  }

  const tPawnRefine = Date.now() - t;

  // Step 5: Correct for flip
  const correctedFen = orientation.flipped ? flipFen(rawFen) : rawFen;
  if (orientation.flipped) {
    highlightedSquares = highlightedSquares.map(i => 63 - i);
  }

  // Step 5b: Check for mid-animation frames.
  // Highlights indicate a move (from=empty, to=piece) but if both highlighted
  // squares are empty, the piece is still sliding and hasn't landed yet.
  let midAnimation = false;
  if (highlightedSquares.length === 2) {
    const corrRows = correctedFen.split('/');
    const corrBoard: (string | null)[] = new Array(64).fill(null);
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of corrRows[r]) {
        if (ch >= '1' && ch <= '8') f += parseInt(ch);
        else { corrBoard[r * 8 + f] = ch; f++; }
      }
    }
    const h0 = corrBoard[highlightedSquares[0]];
    const h1 = corrBoard[highlightedSquares[1]];
    // Both empty = piece mid-slide (hasn't landed on either square)
    if (!h0 && !h1) midAnimation = true;
  }

  // Step 6: Determine turn from highlights
  t = Date.now();
  const turn = turnFromHighlight(highlightedSquares, correctedFen);

  // Step 7: Build full FEN (only when turn is known)
  const fullFen = turn ? buildFullFen(correctedFen, turn) : null;
  const tTurn = Date.now() - t;
  const tTotal = Date.now() - t0;

  return {
    rawFen,
    correctedFen,
    fullFen,
    recognition: { ...recognition, fen: correctedFen },
    highlightedSquares,
    flipped: orientation.flipped,
    turn,
    midAnimation,
    orientationSource: orientation.source,
    timing: {
      pieces_ms: tPieces,
      orientation_ms: tOrientation,
      highlights_ms: tHighlights,
      disambiguate_ms: tDisambiguate,
      pawnRefine_ms: tPawnRefine,
      turn_ms: tTurn,
      total_ms: tTotal,
    },
  };
}
