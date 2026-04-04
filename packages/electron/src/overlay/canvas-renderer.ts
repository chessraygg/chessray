import type { ArrowDescriptor, PipelineResult } from '@chessray/core';
import { computeCurveOffsets, computePvArrows } from '@chessray/core';

export interface OverlayState {
  videoCanvas: HTMLCanvasElement | null;
  canvas: HTMLCanvasElement | null;
  currentResult: PipelineResult | null;
  currentArrows: ArrowDescriptor[];
  displayFlipped: boolean;
  overlayVisible: boolean;
  borderVisible: boolean;
  arrowsVisible: boolean;
  lineVisible: boolean;
  pvDepth: number;
  evalBarVisible: boolean;
  sourceVisible: boolean;
  selectedLineIndex: number;
  displayInfo: {
    size: { width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
    overlayBounds?: { x: number; y: number; width: number; height: number };
  } | null;
}

/** Get the arrows to display based on current mode (top moves vs PV line) */
export function getActiveArrows(state: OverlayState): ArrowDescriptor[] {
  if (state.lineVisible && state.currentResult?.evaluation?.top_moves?.length) {
    const idx = Math.min(state.selectedLineIndex, state.currentResult.evaluation.top_moves.length - 1);
    const pv = state.currentResult.evaluation.top_moves[idx].pv;
    // Prefer highlight-based turn (always current) over eval FEN turn (may be stale)
    const turn = state.currentResult.turn
      ?? state.currentResult.evaluation.fen?.split(' ')[1] as 'w' | 'b'
      ?? 'w';
    return computePvArrows(pv, turn, state.pvDepth);
  }
  return state.currentArrows;
}

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  arrow: ArrowDescriptor,
  board: { x: number; y: number; width: number; height: number },
  widthScale: number,
  displayFlipped: boolean,
  curveOffset: number = 0,
): void {
  const squareW = board.width / 8;
  const squareH = board.height / 8;

  let fromFile = arrow.from.charCodeAt(0) - 97;
  let fromRank = parseInt(arrow.from[1], 10) - 1;
  let toFile = arrow.to.charCodeAt(0) - 97;
  let toRank = parseInt(arrow.to[1], 10) - 1;

  if (displayFlipped) {
    fromFile = 7 - fromFile;
    fromRank = 7 - fromRank;
    toFile = 7 - toFile;
    toRank = 7 - toRank;
  }

  const x1 = board.x + fromFile * squareW + squareW / 2;
  const y1 = board.y + (7 - fromRank) * squareH + squareH / 2;
  const x2 = board.x + toFile * squareW + squareW / 2;
  const y2 = board.y + (7 - toRank) * squareH + squareH / 2;

  const lineWidth = arrow.width * widthScale;
  const headLength = lineWidth * 3;

  // Compute perpendicular offset for the control point (curve)
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  // Perpendicular unit vector (rotated 90° CCW)
  const px = len > 0 ? -dy / len : 0;
  const py = len > 0 ? dx / len : 0;
  const offsetPx = curveOffset * (squareW + squareH) / 2;

  // Control point at midpoint, offset perpendicular to the arrow
  const mx = (x1 + x2) / 2 + px * offsetPx;
  const my = (y1 + y2) / 2 + py * offsetPx;

  // For the arrowhead, compute the tangent angle at the endpoint of the curve.
  // For a quadratic bezier, the tangent at t=1 is the direction from control point to end.
  const tipAngle = Math.atan2(y2 - my, x2 - mx);

  // Shorten the curve so it ends before the arrowhead
  const tipBackX = x2 - headLength * Math.cos(tipAngle);
  const tipBackY = y2 - headLength * Math.sin(tipAngle);

  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  // Gradient stroke: transparent at source, full opacity at arrowhead
  const grad = ctx.createLinearGradient(x1, y1, tipBackX, tipBackY);
  const r = parseInt(arrow.color.slice(1, 3), 16);
  const g = parseInt(arrow.color.slice(3, 5), 16);
  const b = parseInt(arrow.color.slice(5, 7), 16);
  grad.addColorStop(0, `rgba(${r},${g},${b},${(arrow.opacity * 0.15).toFixed(2)})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},${arrow.opacity.toFixed(2)})`);

  // Draw the shaft (quadratic bezier curve)
  ctx.strokeStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if (curveOffset === 0) {
    ctx.lineTo(tipBackX, tipBackY);
  } else {
    ctx.quadraticCurveTo(mx, my, tipBackX, tipBackY);
  }
  ctx.stroke();

  // Draw the arrowhead at full opacity
  ctx.globalAlpha = arrow.opacity;
  ctx.fillStyle = arrow.color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLength * Math.cos(tipAngle - Math.PI / 6), y2 - headLength * Math.sin(tipAngle - Math.PI / 6));
  ctx.lineTo(x2 - headLength * Math.cos(tipAngle + Math.PI / 6), y2 - headLength * Math.sin(tipAngle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();

  // Draw label near arrow start (e.g. move number for PV line)
  if (arrow.label) {
    const fontSize = Math.max(6, lineWidth * 2);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = arrow.opacity;
    // Small circle offset from arrow start
    const r = fontSize * 0.55;
    const ox = x1 - r * 1.5;
    const oy = y1 - r * 1.5;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fillStyle = arrow.color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(arrow.label, ox, oy);
  }

  ctx.restore();
}

export function renderArrows(state: OverlayState): void {
  if (!state.canvas) return;

  const size = 200;
  const dpr = window.devicePixelRatio || 1;

  // Scale canvas buffer for Retina sharpness
  if (state.canvas.width !== size * dpr || state.canvas.height !== size * dpr) {
    state.canvas.width = size * dpr;
    state.canvas.height = size * dpr;
    state.canvas.style.width = `${size}px`;
    state.canvas.style.height = `${size}px`;
  }

  const ctx = state.canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const virtualBoard = { x: 0, y: 0, width: size, height: size };
  const arrows = getActiveArrows(state);

  if (arrows.length === 0) return;

  const offsets = computeCurveOffsets(arrows);
  for (let i = arrows.length - 1; i >= 0; i--) {
    drawArrow(ctx, arrows[i], virtualBoard, 1, state.displayFlipped, offsets[i]);
  }
}

/** Draw arrows and eval bar on the full-screen overlay canvas */
export function renderVideoOverlay(state: OverlayState): void {
  if (!state.videoCanvas) return;
  const ctx = state.videoCanvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, state.videoCanvas.width, state.videoCanvas.height);

  if (!state.sourceVisible) return;

  const result = state.currentResult;
  if (!result?.board_detection?.found || !result.board_detection.bbox || !result.frame_dimensions) return;

  const frameW = result.frame_dimensions.width;
  const frameH = result.frame_dimensions.height;

  // The overlay window covers the work area (excludes menu bar/dock).
  // The captured frame covers the full display (includes menu bar).
  // We need to map frame pixels → overlay CSS pixels, accounting for:
  // 1. devicePixelRatio (frame is in physical pixels, overlay is in CSS pixels)
  // 2. Menu bar offset (frame y=0 is top of screen, overlay y=0 is top of work area)
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (state.videoCanvas.width !== vw || state.videoCanvas.height !== vh) {
    state.videoCanvas.width = vw;
    state.videoCanvas.height = vh;
    state.videoCanvas.style.width = vw + 'px';
    state.videoCanvas.style.height = vh + 'px';
  }

  // Frame is in physical pixels, overlay canvas is in CSS pixels.
  // Divide by devicePixelRatio to convert frame → CSS pixels.
  // The overlay window may be offset from the top of the screen (e.g. macOS
  // menu bar pushes it to y=25). Use the actual overlay bounds to compute the
  // offset between frame coordinates (screen-relative) and overlay coordinates.
  const dpr = state.displayInfo?.scaleFactor ?? window.devicePixelRatio;
  // overlayBounds.y is in screen points (from Electron getBounds), not physical pixels.
  const overlayYOffset = state.displayInfo?.overlayBounds?.y ?? 0;

  const bbox = result.board_detection.bbox;
  const bx = bbox.x / dpr;
  const by = bbox.y / dpr - overlayYOffset;
  const bw = bbox.width / dpr;
  const bh = bbox.height / dpr;

  const boardRect = { x: bx, y: by, width: bw, height: bh };

  if (state.borderVisible) {
    ctx.strokeStyle = 'rgba(255, 0, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
  }

  if (state.arrowsVisible || state.lineVisible) {
    const arrows = getActiveArrows(state);
    const arrowScale = (bw + bh) / 2 / 192;

    const offsets = computeCurveOffsets(arrows);
    for (let i = arrows.length - 1; i >= 0; i--) {
      drawArrow(ctx, arrows[i], boardRect, arrowScale, state.displayFlipped, offsets[i]);
    }
  }

  // Eval bar
  if (state.evalBarVisible && result.evaluation?.top_moves?.length) {
    const sideScore = result.evaluation.top_moves[0].score_cp;
    const turn = result.evaluation.fen?.split(' ')[1] || 'w';
    const bestScore = turn === 'b' ? -sideScore : sideScore;
    const winProb = 1 / (1 + Math.pow(10, -bestScore / 400));

    const barW = Math.max(8, Math.round(bw * 0.04));
    const barX = bx > barW + 4
      ? bx - barW
      : bx + bw;

    const whiteH = bh * winProb;
    const blackH = bh - whiteH;

    if (state.displayFlipped) {
      ctx.fillStyle = '#eee';
      ctx.fillRect(barX, by, barW, whiteH);
      ctx.fillStyle = '#222';
      ctx.fillRect(barX, by + whiteH, barW, blackH);
    } else {
      ctx.fillStyle = '#222';
      ctx.fillRect(barX, by, barW, blackH);
      ctx.fillStyle = '#eee';
      ctx.fillRect(barX, by + blackH, barW, whiteH);
    }
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, by, barW, bh);
  }
}

export function clearVideoOverlay(state: OverlayState): void {
  if (!state.videoCanvas) return;
  const ctx = state.videoCanvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, state.videoCanvas.width, state.videoCanvas.height);
}
