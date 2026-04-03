import { Chess } from 'chess.js';

/**
 * Convert an array of UCI moves to SAN notation given a starting FEN position.
 * Each move is applied sequentially to advance the position.
 * If a move is invalid, the UCI string is returned as-is.
 */
export function uciToSan(fen: string, uciMoves: string[]): string[] {
  const chess = new Chess(fen);
  const result: string[] = [];

  for (const uci of uciMoves) {
    try {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const move = chess.move({ from, to, promotion });
      result.push(move.san);
    } catch {
      result.push(uci);
    }
  }

  return result;
}

/**
 * Format an array of SAN moves into standard notation with move numbers.
 * e.g. ["e4", "e5", "Nf3"] with startTurn 'w' -> "1.e4 e5 2.Nf3"
 * If starting as black, first move uses "1..." prefix.
 */
export function formatMoveLine(sanMoves: string[], startTurn: 'w' | 'b'): string {
  if (sanMoves.length === 0) return '';

  const parts: string[] = [];
  let moveNumber = 1;
  let isWhiteTurn = startTurn === 'w';

  for (let i = 0; i < sanMoves.length; i++) {
    if (isWhiteTurn) {
      parts.push(`${moveNumber}.${sanMoves[i]}`);
    } else {
      if (i === 0) {
        parts.push(`${moveNumber}...${sanMoves[i]}`);
      } else {
        parts.push(sanMoves[i]);
      }
      moveNumber++;
    }
    isWhiteTurn = !isWhiteTurn;
  }

  return parts.join(' ');
}
