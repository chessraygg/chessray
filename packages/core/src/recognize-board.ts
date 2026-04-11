import type { RecognitionResult } from './types.js';
import type { PixelBuffer } from './pixel-utils.js';
import { detectHighlightedSquares, disambiguateHighlights, turnFromHighlight } from './highlight.js';
import { detectBoardFlipped, type OrientationSource } from './orientation.js';
import { flipFen, buildFullFen } from './fen.js';
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
): Promise<BoardRecognitionResult> {
  // Step 1: Recognize pieces
  const recognition = await recognizer.recognize(cropped as unknown as ImageData);
  const rawFen = recognition.fen;

  // Step 2: Detect orientation (before highlights — disambiguation needs flip info)
  const pieceCount = rawFen.replace(/[0-8/]/g, '').length;
  let orientation: import('./image-utils.js').OrientationResult;
  if (pieceCount >= 20) {
    orientation = detectBoardFlipped(rawFen);
  } else {
    const labelResult = await detectLabels(cropped);
    orientation = labelResult ?? detectBoardFlipped(rawFen);
  }

  // Step 3: Detect and disambiguate highlights
  const hlResult = detectHighlightedSquares(cropped);
  let highlightedSquares = disambiguateHighlights(hlResult.highlighted, rawFen, hlResult.scores, hlResult.colors, hlResult.medians, orientation.flipped);

  // Step 4: Refine orientation using pawn move direction from highlights.
  // If a pawn moved, its direction is an authoritative orientation signal
  // that can correct piece_count errors in sparse positions.
  if (highlightedSquares.length === 2) {
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

  // Step 5: Correct for flip
  const correctedFen = orientation.flipped ? flipFen(rawFen) : rawFen;
  if (orientation.flipped) {
    highlightedSquares = highlightedSquares.map(i => 63 - i);
  }

  // Step 5: Determine turn from highlights
  const turn = turnFromHighlight(highlightedSquares, correctedFen);

  // Step 6: Build full FEN (only when turn is known)
  const fullFen = turn ? buildFullFen(correctedFen, turn) : null;

  return {
    rawFen,
    correctedFen,
    fullFen,
    recognition: { ...recognition, fen: correctedFen },
    highlightedSquares,
    flipped: orientation.flipped,
    turn,
    orientationSource: orientation.source,
  };
}
