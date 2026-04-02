import { describe, it, expect } from 'vitest';
import {
  lossToColor,
  rankToWidth,
  rankToOpacity,
  computeArrows,
  squareToPixel,
  arrowGeometry,
} from '../src/arrows.js';
import type { EvalMove } from '../src/types.js';

describe('lossToColor', () => {
  it('returns green for 0 cp loss', () => {
    expect(lossToColor(0)).toBe('#22c55e');
  });

  it('returns red for 200+ cp loss', () => {
    expect(lossToColor(200)).toBe('#ef4444');
    expect(lossToColor(500)).toBe('#ef4444');
  });

  it('returns an intermediate color for 50 cp', () => {
    const color = lossToColor(50);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(color).not.toBe('#22c55e'); // not green
    expect(color).not.toBe('#ef4444'); // not red
  });

  it('returns yellow-ish for 50 cp', () => {
    const color = lossToColor(50);
    // Should be close to #eab308
    expect(color).toBe('#eab308');
  });
});

describe('rankToWidth', () => {
  it('returns decreasing widths for ranks 0, 1, 2', () => {
    expect(rankToWidth(0)).toBeGreaterThan(rankToWidth(1));
    expect(rankToWidth(1)).toBeGreaterThan(rankToWidth(2));
  });
});

describe('rankToOpacity', () => {
  it('returns decreasing opacity for ranks 0, 1, 2', () => {
    expect(rankToOpacity(0)).toBeGreaterThan(rankToOpacity(1));
    expect(rankToOpacity(1)).toBeGreaterThan(rankToOpacity(2));
  });

  it('returns 1.0 for best move', () => {
    expect(rankToOpacity(0)).toBe(0.9);
  });
});

describe('computeArrows', () => {
  const topMoves: EvalMove[] = [
    { move: 'e2e4', score_cp: 30, loss_cp: 0, pv: ['e2e4', 'e7e5'] },
    { move: 'd2d4', score_cp: 20, loss_cp: 10, pv: ['d2d4', 'd7d5'] },
    { move: 'g1f3', score_cp: -5, loss_cp: 35, pv: ['g1f3', 'e7e5'] },
  ];

  it('returns 3 arrows for 3 moves', () => {
    const arrows = computeArrows(topMoves);
    expect(arrows).toHaveLength(3);
  });

  it('best move has green color and 0 loss', () => {
    const arrows = computeArrows(topMoves);
    expect(arrows[0].color).toBe('#22c55e');
    expect(arrows[0].loss_cp).toBe(0);
  });

  it('arrows have decreasing width', () => {
    const arrows = computeArrows(topMoves);
    expect(arrows[0].width).toBeGreaterThan(arrows[1].width);
    expect(arrows[1].width).toBeGreaterThan(arrows[2].width);
  });

  it('arrows have correct from/to squares', () => {
    const arrows = computeArrows(topMoves);
    expect(arrows[0].from).toBe('e2');
    expect(arrows[0].to).toBe('e4');
    expect(arrows[1].from).toBe('d2');
    expect(arrows[1].to).toBe('d4');
  });
});

describe('squareToPixel', () => {
  const boardRect = { x: 0, y: 0, width: 800, height: 800 };

  it('maps a1 to bottom-left for white orientation', () => {
    const pixel = squareToPixel('a1', boardRect, 'w');
    expect(pixel.x).toBe(50); // center of first file
    expect(pixel.y).toBe(750); // center of bottom rank
  });

  it('maps h8 to top-right for white orientation', () => {
    const pixel = squareToPixel('h8', boardRect, 'w');
    expect(pixel.x).toBe(750);
    expect(pixel.y).toBe(50);
  });

  it('flips for black orientation', () => {
    const pixelW = squareToPixel('a1', boardRect, 'w');
    const pixelB = squareToPixel('a1', boardRect, 'b');
    expect(pixelW.x).not.toBe(pixelB.x);
    expect(pixelW.y).not.toBe(pixelB.y);
  });
});

describe('arrowGeometry', () => {
  const boardRect = { x: 100, y: 50, width: 400, height: 400 };

  it('returns pixel coordinates offset by board position', () => {
    const geo = arrowGeometry('e2', 'e4', boardRect, 'w');
    expect(geo.x1).toBeGreaterThan(100);
    expect(geo.y1).toBeGreaterThan(50);
    expect(geo.x1).toBe(geo.x2); // same file = same x
    expect(geo.y1).toBeGreaterThan(geo.y2); // e2 is below e4
  });
});
