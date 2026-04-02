import { describe, it, expect } from 'vitest';
import {
  validateFen,
  fenToBoard,
  boardToFen,
  compareFen,
  guessTurn,
  squareToIndex,
  indexToSquare,
  buildFullFen,
} from '../src/fen.js';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const STARTING_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe('validateFen', () => {
  it('accepts valid starting position', () => {
    expect(validateFen(STARTING_FEN).valid).toBe(true);
  });

  it('accepts position after 1.e4', () => {
    expect(validateFen(AFTER_E4).valid).toBe(true);
  });

  it('rejects invalid FEN', () => {
    expect(validateFen('not a fen').valid).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateFen('').valid).toBe(false);
  });
});

describe('fenToBoard', () => {
  it('converts starting position to 8x8 array', () => {
    const board = fenToBoard(STARTING_FEN);
    expect(board).toHaveLength(8);
    expect(board[0]).toHaveLength(8);

    // Rank 8 (black pieces)
    expect(board[0]).toEqual(['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']);
    // Rank 7 (black pawns)
    expect(board[1]).toEqual(['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p']);
    // Rank 6-3 (empty)
    expect(board[2]).toEqual([null, null, null, null, null, null, null, null]);
    // Rank 2 (white pawns)
    expect(board[6]).toEqual(['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);
    // Rank 1 (white pieces)
    expect(board[7]).toEqual(['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']);
  });

  it('handles position after 1.e4', () => {
    const board = fenToBoard(AFTER_E4);
    // e4 pawn: rank 4 (index 4), file e (index 4)
    expect(board[4][4]).toBe('P');
    // e2 should be empty
    expect(board[6][4]).toBe(null);
  });
});

describe('boardToFen', () => {
  it('round-trips starting position', () => {
    const board = fenToBoard(STARTING_FEN);
    expect(boardToFen(board)).toBe(STARTING_POSITION);
  });

  it('round-trips position after 1.e4', () => {
    const board = fenToBoard(AFTER_E4);
    expect(boardToFen(board)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR');
  });
});

describe('compareFen', () => {
  it('returns true for identical positions', () => {
    expect(compareFen(STARTING_FEN, STARTING_FEN)).toBe(true);
  });

  it('returns true when only metadata differs', () => {
    const a = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const b = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b Kq - 5 10';
    expect(compareFen(a, b)).toBe(true);
  });

  it('returns false for different positions', () => {
    expect(compareFen(STARTING_FEN, AFTER_E4)).toBe(false);
  });
});

describe('guessTurn', () => {
  it('returns white when no previous position', () => {
    expect(guessTurn(null, STARTING_POSITION)).toBe('w');
  });

  it('returns black after white moves e2-e4', () => {
    const before = STARTING_POSITION;
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';
    expect(guessTurn(before, after)).toBe('b');
  });
});

describe('squareToIndex / indexToSquare', () => {
  it('converts a8 to [0,0]', () => {
    expect(squareToIndex('a8')).toEqual([0, 0]);
  });

  it('converts h1 to [7,7]', () => {
    expect(squareToIndex('h1')).toEqual([7, 7]);
  });

  it('converts e4 to [4,4]', () => {
    expect(squareToIndex('e4')).toEqual([4, 4]);
  });

  it('round-trips', () => {
    expect(indexToSquare(0, 0)).toBe('a8');
    expect(indexToSquare(7, 7)).toBe('h1');
    expect(indexToSquare(4, 4)).toBe('e4');
  });
});

describe('buildFullFen', () => {
  it('builds a complete FEN', () => {
    expect(buildFullFen(STARTING_POSITION, 'w', 'KQkq', '-', 0, 1)).toBe(STARTING_FEN);
  });
});
