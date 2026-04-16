import { Chess } from 'chess.js';
import type { Turn } from '../types.js';

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
 * Apply N UCI moves to a FEN position and return the resulting position-only FEN
 * plus the from/to square indices of the last move applied.
 */
export function applyUciMoves(fen: string, uciMoves: string[], count: number): { fen: string; highlight: number[] } | null {
  try {
    const chess = new Chess(fen);
    let lastFrom = -1, lastTo = -1;
    for (let i = 0; i < count && i < uciMoves.length; i++) {
      const from = uciMoves[i].slice(0, 2);
      const to = uciMoves[i].slice(2, 4);
      const promotion = uciMoves[i].length > 4 ? uciMoves[i][4] : undefined;
      chess.move({ from, to, promotion });
      lastFrom = (8 - parseInt(from[1])) * 8 + (from.charCodeAt(0) - 97);
      lastTo = (8 - parseInt(to[1])) * 8 + (to.charCodeAt(0) - 97);
    }
    return { fen: chess.fen().split(' ')[0], highlight: lastFrom >= 0 ? [lastFrom, lastTo] : [] };
  } catch { return null; }
}

/**
 * Format an array of SAN moves into standard notation with move numbers.
 * e.g. ["e4", "e5", "Nf3"] with startTurn 'w' -> "1.e4 e5 2.Nf3"
 * If starting as black, first move uses "1..." prefix.
 */
export function formatMoveLine(sanMoves: string[], startTurn: Turn): string {
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
