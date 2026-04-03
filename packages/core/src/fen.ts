import { Chess } from 'chess.js';

/** Piece character or null for empty square */
export type PieceChar = 'p' | 'n' | 'b' | 'r' | 'q' | 'k' | 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | null;

/** 8x8 board representation, board[rank][file] where rank 0 = rank 8 (top) */
export type Board = PieceChar[][];

const PIECE_CHARS = new Set('pnbrqkPNBRQK');

/**
 * Validate a FEN string.
 */
export function validateFen(fen: string): { valid: boolean; error?: string } {
  try {
    new Chess(fen);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

/**
 * Convert a FEN string to an 8x8 board array.
 * board[0] = rank 8 (top), board[7] = rank 1 (bottom)
 * board[rank][0] = a-file, board[rank][7] = h-file
 */
export function fenToBoard(fen: string): Board {
  const position = fen.split(' ')[0];
  const ranks = position.split('/');
  const board: Board = [];

  for (const rank of ranks) {
    const row: PieceChar[] = [];
    for (const ch of rank) {
      if (PIECE_CHARS.has(ch)) {
        row.push(ch as PieceChar);
      } else {
        const empty = parseInt(ch, 10);
        for (let i = 0; i < empty; i++) {
          row.push(null);
        }
      }
    }
    board.push(row);
  }

  return board;
}

/**
 * Convert an 8x8 board array back to a FEN position string (just the piece placement part).
 */
export function boardToFen(board: Board): string {
  return board
    .map((rank) => {
      let row = '';
      let emptyCount = 0;
      for (const piece of rank) {
        if (piece === null) {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            row += emptyCount;
            emptyCount = 0;
          }
          row += piece;
        }
      }
      if (emptyCount > 0) row += emptyCount;
      return row;
    })
    .join('/');
}

/**
 * Compare two FEN strings by position only (ignoring turn, castling, en passant, etc).
 */
export function compareFen(a: string, b: string): boolean {
  return a.split(' ')[0] === b.split(' ')[0];
}

/**
 * Guess whose turn it is by comparing previous and current FEN.
 * Looks at which side lost a piece or which side's pieces moved.
 */
const STARTING_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

export function guessTurn(prevFen: string | null, currFen: string): 'w' | 'b' {
  const posOnly = currFen.split(' ')[0];
  if (posOnly === STARTING_POSITION) return 'w';
  if (!prevFen) return 'w';

  // If all pawns are on their starting ranks (no moves made), it's white to move
  const ranks = posOnly.split('/');
  if (ranks[1]?.replace(/[^p]/g, '').length === 8 && ranks[6]?.replace(/[^P]/g, '').length === 8) {
    return 'w';
  }

  const prevBoard = fenToBoard(prevFen);
  const currBoard = fenToBoard(currFen);

  let whiteDiff = 0;
  let blackDiff = 0;

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const prev = prevBoard[r][f];
      const curr = currBoard[r][f];
      if (prev !== curr) {
        if (prev && prev === prev.toUpperCase()) whiteDiff++;
        if (prev && prev === prev.toLowerCase()) blackDiff++;
        if (curr && curr === curr.toUpperCase()) whiteDiff++;
        if (curr && curr === curr.toLowerCase()) blackDiff++;
      }
    }
  }

  // If white pieces changed more, white just moved, so it's black's turn
  return whiteDiff >= blackDiff ? 'b' : 'w';
}

/**
 * Build a full FEN string from a position string and optional metadata.
 */
export function buildFullFen(
  position: string,
  turn: 'w' | 'b' = 'w',
  castling?: string,
  enPassant: string = '-',
  halfmove: number = 0,
  fullmove: number = 1
): string {
  const rights = castling ?? inferCastlingRights(position);
  return `${position} ${turn} ${rights} ${enPassant} ${halfmove} ${fullmove}`;
}

/**
 * Infer castling rights from piece positions.
 * Only grants rights when king is on e-file and rook is on a/h-file
 * in the correct rank (1 for white, 8 for black).
 */
function inferCastlingRights(position: string): string {
  const rows = position.split('/');
  // rows[0] = rank 8 (black back rank), rows[7] = rank 1 (white back rank)
  const rank1 = rows[7] || '';
  const rank8 = rows[0] || '';

  // Expand FEN row to 8 chars (e.g. "r3k2r" → "r3k2r", "4K3" → "....K...")
  function expand(row: string): string {
    let out = '';
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') out += '.'.repeat(parseInt(ch));
      else out += ch;
    }
    return out;
  }

  const w = expand(rank1);
  const b = expand(rank8);

  let rights = '';
  // White: king on e1 (index 4), rooks on h1 (7) and a1 (0)
  if (w[4] === 'K') {
    if (w[7] === 'R') rights += 'K';
    if (w[0] === 'R') rights += 'Q';
  }
  // Black: king on e8 (index 4), rooks on h8 (7) and a8 (0)
  if (b[4] === 'k') {
    if (b[7] === 'r') rights += 'k';
    if (b[0] === 'r') rights += 'q';
  }

  return rights || '-';
}

/**
 * Convert algebraic square to [rank_index, file_index] for board array.
 * a8 -> [0,0], h1 -> [7,7]
 */
export function squareToIndex(square: string): [number, number] {
  const file = square.charCodeAt(0) - 97; // a=0, h=7
  const rank = 8 - parseInt(square[1], 10); // 8->0, 1->7
  return [rank, file];
}

/**
 * Convert [rank_index, file_index] to algebraic square.
 */
export function indexToSquare(rank: number, file: number): string {
  return String.fromCharCode(97 + file) + (8 - rank);
}

/**
 * Flip a position FEN (piece placement only) 180 degrees.
 * Used when the board is displayed with black at the bottom.
 * Reverses rank order and reverses each rank (mirrors files).
 */
export function flipFen(fen: string): string {
  return fen.split('/').reverse().map(rank => rank.split('').reverse().join('')).join('/');
}

