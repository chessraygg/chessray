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

  // Step 2: Detect and disambiguate highlights
  let highlightedSquares = detectHighlightedSquares(cropped).highlighted;
  highlightedSquares = disambiguateHighlights(highlightedSquares, rawFen);

  // Step 3: Detect orientation
  // With 20+ pieces, heuristic (pawn_move / piece_count) is fast and reliable.
  // Only run slow OCR label detection in sparse positions where heuristic is unreliable.
  const pieceCount = rawFen.replace(/[0-8/]/g, '').length;
  let orientation: import('./image-utils.js').OrientationResult;
  if (pieceCount >= 20) {
    orientation = detectBoardFlipped(rawFen, highlightedSquares);
  } else {
    const labelResult = await detectLabels(cropped);
    orientation = labelResult ?? detectBoardFlipped(rawFen, highlightedSquares);
  }

  // Step 4: Correct for flip
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
