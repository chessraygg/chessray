import type { ArrowDescriptor, EvalMove, BoardBBox } from './types.js';

/**
 * Map centipawn loss to a hex color.
 * 0cp = green, ~50cp = yellow, ~100cp = orange, 200+cp = red
 */
export function lossToColor(lossCp: number): string {
  const loss = Math.abs(lossCp);
  if (loss <= 0) return '#22c55e'; // green
  if (loss >= 200) return '#ef4444'; // red

  // Interpolate through green -> yellow -> orange -> red
  if (loss <= 50) {
    // Green (#22c55e) to Yellow (#eab308)
    const t = loss / 50;
    return interpolateColor('#22c55e', '#eab308', t);
  } else if (loss <= 100) {
    // Yellow (#eab308) to Orange (#f97316)
    const t = (loss - 50) / 50;
    return interpolateColor('#eab308', '#f97316', t);
  } else {
    // Orange (#f97316) to Red (#ef4444)
    const t = (loss - 100) / 100;
    return interpolateColor('#f97316', '#ef4444', t);
  }
}

/**
 * Map move rank (0=best, 1=second, 2=third) to arrow width.
 */
export function rankToWidth(rank: number): number {
  const widths = [5, 4, 3];
  return widths[Math.min(rank, widths.length - 1)];
}

/**
 * Map move rank to opacity.
 */
export function rankToOpacity(rank: number): number {
  const opacities = [0.9, 0.7, 0.5];
  return opacities[Math.min(rank, opacities.length - 1)];
}

/**
 * Compute arrow descriptors from Stockfish top moves.
 */
export function computeArrows(topMoves: EvalMove[]): ArrowDescriptor[] {
  return topMoves.map((move, i) => {
    const from = move.move.slice(0, 2);
    const to = move.move.slice(2, 4);

    return {
      from,
      to,
      color: lossToColor(move.loss_cp),
      width: rankToWidth(i),
      opacity: rankToOpacity(i),
      loss_cp: move.loss_cp,
    };
  });
}

/**
 * Compute arrow descriptors for the principal variation (best line).
 * Shows a sequence of moves alternating white/black with numbered labels.
 * @param pv - Array of UCI move strings from Stockfish PV
 * @param turn - Whose turn it is for the first move ('w' or 'b')
 * @param maxMoves - Maximum number of PV moves to show
 */
export function computePvArrows(pv: string[], turn: 'w' | 'b', maxMoves: number): ArrowDescriptor[] {
  const moves = pv.slice(0, maxMoves);
  let side = turn;

  return moves.map((uci, i) => {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const isWhite = side === 'w';

    // Alternate colors: green/blue for white moves, orange/red for black moves
    const color = isWhite ? '#22c55e' : '#ef4444';

    // First move thick, subsequent thinner
    const width = Math.max(2, 5 - i);
    // Fade out progressively
    const opacity = Math.max(0.3, 0.9 - i * 0.12);

    const arrow: ArrowDescriptor = {
      from, to, color, width, opacity,
      loss_cp: 0,
      label: String(i + 1),
    };

    // Alternate side
    side = side === 'w' ? 'b' : 'w';
    return arrow;
  });
}

/**
 * Convert algebraic square to pixel coordinates relative to a board rectangle.
 * Returns the center of the square.
 */
export function squareToPixel(
  square: string,
  boardRect: { x: number; y: number; width: number; height: number },
  orientation: 'w' | 'b' = 'w'
): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97; // a=0, h=7
  const rank = parseInt(square[1], 10) - 1; // 1->0, 8->7

  const squareW = boardRect.width / 8;
  const squareH = boardRect.height / 8;

  let pixelFile: number;
  let pixelRank: number;

  if (orientation === 'w') {
    pixelFile = file;
    pixelRank = 7 - rank; // rank 8 at top
  } else {
    pixelFile = 7 - file;
    pixelRank = rank;
  }

  return {
    x: boardRect.x + pixelFile * squareW + squareW / 2,
    y: boardRect.y + pixelRank * squareH + squareH / 2,
  };
}

/**
 * Compute arrow geometry (pixel coordinates) for a move.
 */
export function arrowGeometry(
  from: string,
  to: string,
  boardRect: { x: number; y: number; width: number; height: number },
  orientation: 'w' | 'b' = 'w'
): { x1: number; y1: number; x2: number; y2: number } {
  const fromPixel = squareToPixel(from, boardRect, orientation);
  const toPixel = squareToPixel(to, boardRect, orientation);

  return {
    x1: fromPixel.x,
    y1: fromPixel.y,
    x2: toPixel.x,
    y2: toPixel.y,
  };
}

/**
 * Compute perpendicular curve offsets for overlapping arrows.
 * Two arrows "overlap" if they pass through at least 2 common board squares.
 * Returns an array of offset fractions (0 = straight, nonzero = curve).
 * The offset is a fraction of the square size, applied perpendicular to the arrow.
 */
export function computeCurveOffsets(arrows: ArrowDescriptor[]): number[] {
  const offsets = new Array<number>(arrows.length).fill(0);
  if (arrows.length < 2) return offsets;

  // Get the set of squares each arrow passes through
  const squareSets = arrows.map((a) => {
    const f1 = a.from.charCodeAt(0) - 97;
    const r1 = parseInt(a.from[1], 10) - 1;
    const f2 = a.to.charCodeAt(0) - 97;
    const r2 = parseInt(a.to[1], 10) - 1;
    return bresenhamSquares(f1, r1, f2, r2);
  });

  for (let i = 0; i < arrows.length; i++) {
    for (let j = i + 1; j < arrows.length; j++) {
      const shared = countSharedSquares(squareSets[i], squareSets[j]);
      if (shared < 2) continue;

      // Push the lower-priority arrow (higher index) outward.
      // Best move (index 0) stays straight unless it also overlaps.
      if (offsets[j] === 0) offsets[j] = 0.35;
      else offsets[j] += 0.15;

      if (offsets[i] === 0 && i > 0) offsets[i] = -0.2;
    }
  }

  return offsets;
}

/** Get all board squares a line passes through using Bresenham's algorithm. */
function bresenhamSquares(x0: number, y0: number, x1: number, y1: number): Set<string> {
  const squares = new Set<string>();
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;

  while (true) {
    squares.add(`${cx},${cy}`);
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }

  return squares;
}

/** Count how many squares two sets have in common. */
function countSharedSquares(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const sq of a) {
    if (b.has(sq)) count++;
  }
  return count;
}

/** Linearly interpolate between two hex colors */
function interpolateColor(color1: string, color2: string, t: number): string {
  const r1 = parseInt(color1.slice(1, 3), 16);
  const g1 = parseInt(color1.slice(3, 5), 16);
  const b1 = parseInt(color1.slice(5, 7), 16);
  const r2 = parseInt(color2.slice(1, 3), 16);
  const g2 = parseInt(color2.slice(3, 5), 16);
  const b2 = parseInt(color2.slice(5, 7), 16);

  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);

  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}
