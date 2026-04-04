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
  const opacities = [0.675, 0.525, 0.375];
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
    const opacity = Math.max(0.4, 0.675 - i * 0.06);

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
 * Uses geometric line-segment intersection (not square-level).
 * Two arrows overlap if their straight-line segments intersect at a point
 * that is not a shared endpoint (start/end square center).
 * All intersections are computed on straight lines upfront, then curves applied.
 */
export function computeCurveOffsets(arrows: ArrowDescriptor[]): number[] {
  const offsets = new Array<number>(arrows.length).fill(0);
  if (arrows.length < 2) return offsets;

  // Convert arrows to line segments (square center coordinates)
  const segments = arrows.map((a) => ({
    x1: a.from.charCodeAt(0) - 97,
    y1: parseInt(a.from[1], 10) - 1,
    x2: a.to.charCodeAt(0) - 97,
    y2: parseInt(a.to[1], 10) - 1,
  }));

  for (let i = 0; i < arrows.length; i++) {
    for (let j = i + 1; j < arrows.length; j++) {
      if (!segmentsIntersect(segments[i], segments[j])) continue;

      // Push the lower-priority arrow (higher index) outward.
      if (offsets[j] === 0) offsets[j] = 0.35;
      else offsets[j] += 0.15;

      if (offsets[i] === 0 && i > 0) offsets[i] = -0.2;
    }
  }

  return offsets;
}

/**
 * Check if two line segments intersect, excluding shared endpoints.
 * Returns true if the segments cross at a point that is not a common start/end.
 */
function segmentsIntersect(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  // Check if they share an endpoint — if so, that's not a real intersection
  const sharedEndpoints =
    (a.x1 === b.x1 && a.y1 === b.y1) || (a.x1 === b.x2 && a.y1 === b.y2) ||
    (a.x2 === b.x1 && a.y2 === b.y1) || (a.x2 === b.x2 && a.y2 === b.y2);

  // Cross product helper
  const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number) =>
    (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

  const d1 = cross(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const d2 = cross(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  const d3 = cross(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const d4 = cross(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);

  // Standard segment intersection test
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true; // Proper intersection (not at endpoints)
  }

  // Collinear overlap check: segments on the same line
  if (d1 === 0 && d2 === 0) {
    // Both segments are collinear — check if they overlap beyond shared endpoints
    const aMinX = Math.min(a.x1, a.x2), aMaxX = Math.max(a.x1, a.x2);
    const aMinY = Math.min(a.y1, a.y2), aMaxY = Math.max(a.y1, a.y2);
    const bMinX = Math.min(b.x1, b.x2), bMaxX = Math.max(b.x1, b.x2);
    const bMinY = Math.min(b.y1, b.y2), bMaxY = Math.max(b.y1, b.y2);

    const overlapX = aMinX <= bMaxX && bMinX <= aMaxX;
    const overlapY = aMinY <= bMaxY && bMinY <= aMaxY;
    if (overlapX && overlapY) {
      // They overlap — but if they only touch at a shared endpoint, skip
      if (sharedEndpoints) {
        // Check if overlap extends beyond the shared point
        const overlapLenX = Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX);
        const overlapLenY = Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY);
        return overlapLenX > 0 || overlapLenY > 0;
      }
      return true;
    }
  }

  // Endpoint-on-segment: one endpoint touches the other segment's interior
  if (d1 === 0 && onSegment(b, a.x1, a.y1) && !isEndpoint(b, a.x1, a.y1)) return true;
  if (d2 === 0 && onSegment(b, a.x2, a.y2) && !isEndpoint(b, a.x2, a.y2)) return true;
  if (d3 === 0 && onSegment(a, b.x1, b.y1) && !isEndpoint(a, b.x1, b.y1)) return true;
  if (d4 === 0 && onSegment(a, b.x2, b.y2) && !isEndpoint(a, b.x2, b.y2)) return true;

  return false;
}

function onSegment(seg: { x1: number; y1: number; x2: number; y2: number }, px: number, py: number): boolean {
  return px >= Math.min(seg.x1, seg.x2) && px <= Math.max(seg.x1, seg.x2) &&
         py >= Math.min(seg.y1, seg.y2) && py <= Math.max(seg.y1, seg.y2);
}

function isEndpoint(seg: { x1: number; y1: number; x2: number; y2: number }, px: number, py: number): boolean {
  return (px === seg.x1 && py === seg.y1) || (px === seg.x2 && py === seg.y2);
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
