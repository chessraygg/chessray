import { describe, it, expect } from 'vitest';
import { parseInfoLine, parseBestMove } from '../src/stockfish-uci-parser.js';

describe('parseInfoLine', () => {
  it('parses a standard info line with cp score', () => {
    const line = 'info depth 20 seldepth 28 multipv 1 score cp 30 nodes 1234567 nps 1500000 time 823 pv e2e4 e7e5 g1f3';
    const result = parseInfoLine(line);
    expect(result).not.toBeNull();
    expect(result!.depth).toBe(20);
    expect(result!.multipv).toBe(1);
    expect(result!.scoreCp).toBe(30);
    expect(result!.isMate).toBe(false);
    expect(result!.pv).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(result!.nodes).toBe(1234567);
    expect(result!.nps).toBe(1500000);
    expect(result!.time).toBe(823);
  });

  it('parses multipv 2', () => {
    const line = 'info depth 15 multipv 2 score cp -10 pv d2d4 d7d5';
    const result = parseInfoLine(line);
    expect(result).not.toBeNull();
    expect(result!.multipv).toBe(2);
    expect(result!.scoreCp).toBe(-10);
  });

  it('parses mate score', () => {
    const line = 'info depth 20 multipv 1 score mate 3 pv e1g1 h7h6 d1h5';
    const result = parseInfoLine(line);
    expect(result).not.toBeNull();
    expect(result!.isMate).toBe(true);
    expect(result!.mateIn).toBe(3);
    expect(result!.scoreCp).toBe(10000 - 3);
  });

  it('parses negative mate score', () => {
    const line = 'info depth 20 multipv 1 score mate -2 pv e1e2 d8d1';
    const result = parseInfoLine(line);
    expect(result).not.toBeNull();
    expect(result!.isMate).toBe(true);
    expect(result!.mateIn).toBe(-2);
  });

  it('returns null for non-info line', () => {
    expect(parseInfoLine('bestmove e2e4')).toBeNull();
  });

  it('returns null for info line without pv', () => {
    expect(parseInfoLine('info depth 1 score cp 30')).toBeNull();
  });
});

describe('parseBestMove', () => {
  it('parses bestmove with ponder', () => {
    const result = parseBestMove('bestmove e2e4 ponder e7e5');
    expect(result).not.toBeNull();
    expect(result!.bestmove).toBe('e2e4');
    expect(result!.ponder).toBe('e7e5');
  });

  it('parses bestmove without ponder', () => {
    const result = parseBestMove('bestmove e2e4');
    expect(result).not.toBeNull();
    expect(result!.bestmove).toBe('e2e4');
    expect(result!.ponder).toBeUndefined();
  });

  it('returns null for non-bestmove line', () => {
    expect(parseBestMove('info depth 20')).toBeNull();
  });
});
