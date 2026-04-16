import type { ArrowDescriptor, PipelineResult } from '../shared/types.js';
import type { Turn } from '@chessray/core';
import { computeCurveOffsets, computePvArrows, lossToColor } from '../shared/arrows.js';
import { pieceImages } from './piece-svg.js';

export interface PvBoardState {
  fen: string;           // Current board FEN (piece placement only)
  flipped: boolean;
  highlight: number[];   // Highlighted square indices (in non-flipped coordinate space)
  anim: {
    piece: string;       // FEN char being animated (e.g. 'N', 'p')
    fromSq: string;      // UCI source square (e.g. 'e2')
    toSq: string;        // UCI destination square (e.g. 'e4')
    isWhite: boolean;    // White's move (for arrow color)
    step: number;        // Step number (for arrow label)
    progress: number;    // 0→1 animation progress (ease-in-out applied)
    afterFen: string;    // Position after this move completes
    afterHighlight: number[];
  } | null;
}

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
  pvDisplayDepth: number;
  pvWhiteColor: string;
  pvBlackColor: string;
  evalBarVisible: boolean;
  sourceVisible: boolean;
  selectedLineIndex: number;
  lossThreshold: number;
  playedLossThreshold: number;
  autoMode: boolean;
  vboardOverlayVisible: boolean;
  pvPreviewLineIndex: number | null;
  pvBoardState: PvBoardState | null;
  panelScale: number;
  displayInfo: {
    size: { width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
    overlayBounds?: { x: number; y: number; width: number; height: number };
    displayBounds?: { x: number; y: number; width: number; height: number };
  } | null;
}

// ── Arrow fade animation ──

interface AnimatedArrow extends ArrowDescriptor {
  fadeOpacity: number; // current animated opacity (0→target)
  progress: number; // 0→1 extension from source to target
  fading: 'in' | 'out' | 'steady';
}

const FADE_DURATION = 200; // ms
const FADE_STEP = 16; // ~60fps

// Separate animation states for video overlay and virtual board
const videoArrowState = { animated: [] as AnimatedArrow[], timer: 0 as any };
const vboardArrowState = { animated: [] as AnimatedArrow[], timer: 0 as any };

function arrowKey(a: ArrowDescriptor): string {
  return `${a.from}-${a.to}`;
}

function updateAnimatedArrows(
  target: ArrowDescriptor[],
  animState: { animated: AnimatedArrow[]; timer: any },
  onTick: () => void,
): AnimatedArrow[] {
  const targetMap = new Map<string, ArrowDescriptor>();
  for (const a of target) targetMap.set(arrowKey(a), a);

  const prevMap = new Map<string, AnimatedArrow>();
  for (const a of animState.animated) prevMap.set(arrowKey(a), a);

  const next: AnimatedArrow[] = [];

  // Existing or new arrows
  for (const a of target) {
    const key = arrowKey(a);
    const prev = prevMap.get(key);
    if (prev) {
      // Update arrow properties (color, width, opacity), keep animation state
      const steady = prev.progress >= 1;
      next.push({ ...a, fadeOpacity: steady ? a.opacity : prev.fadeOpacity, progress: prev.progress, fading: steady ? 'steady' : 'in' });
    } else {
      // New arrow — extend from source
      next.push({ ...a, fadeOpacity: a.opacity, progress: 0, fading: 'in' });
    }
  }

  // Removed arrows — fade out
  for (const a of animState.animated) {
    if (!targetMap.has(arrowKey(a)) && a.fadeOpacity > 0) {
      next.push({ ...a, fading: 'out' });
    }
  }

  animState.animated = next;

  // Start tick loop if not running
  if (!animState.timer && next.some(a => a.fading !== 'steady')) {
    const step = FADE_DURATION > 0 ? (FADE_STEP / FADE_DURATION) : 1;
    animState.timer = setInterval(() => {
      let needsTick = false;
      animState.animated = animState.animated.filter(a => {
        if (a.fading === 'in') {
          a.progress = Math.min(1, a.progress + step);
          if (a.progress >= 1) { a.progress = 1; a.fading = 'steady'; }
          else needsTick = true;
        } else if (a.fading === 'out') {
          a.fadeOpacity = Math.max(0, a.fadeOpacity - a.opacity * step);
          if (a.fadeOpacity <= 0) return false;
          needsTick = true;
        }
        return true;
      });
      onTick();
      if (!needsTick) { clearInterval(animState.timer); animState.timer = 0; }
    }, FADE_STEP);
  }

  return animState.animated;
}

// ── Piece image cache for canvas rendering ──

const ANALYSIS_LIGHT = '#cdd5de';
const ANALYSIS_DARK = '#7e8ea3';
const ANALYSIS_LIGHT_HL = '#a8c4f0';
const ANALYSIS_DARK_HL = '#6a8fc4';

/** Draw analysis board (background + pieces + animated piece + arrow) on the video overlay canvas */
function drawAnalysisBoard(
  ctx: CanvasRenderingContext2D,
  boardRect: { x: number; y: number; width: number; height: number },
  pvBoard: PvBoardState,
): void {
  const sqW = boardRect.width / 8;
  const sqH = boardRect.height / 8;
  const hlSet = new Set(pvBoard.flipped ? pvBoard.highlight.map(i => 63 - i) : pvBoard.highlight);

  // Draw colored squares
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const idx = rank * 8 + file;
      const isLight = (rank + file) % 2 === 0;
      const isHl = hlSet.has(idx);
      ctx.fillStyle = isLight
        ? (isHl ? ANALYSIS_LIGHT_HL : ANALYSIS_LIGHT)
        : (isHl ? ANALYSIS_DARK_HL : ANALYSIS_DARK);
      ctx.fillRect(boardRect.x + file * sqW, boardRect.y + rank * sqH, sqW, sqH);
    }
  }

  // Parse FEN and draw pieces
  let fenRows = pvBoard.fen.split('/');
  if (pvBoard.flipped) {
    fenRows = fenRows.reverse().map(r => r.split('').reverse().join(''));
  }
  const pieceSize = Math.min(sqW, sqH) * 0.88;

  for (let rank = 0; rank < fenRows.length; rank++) {
    let file = 0;
    for (const ch of fenRows[rank]) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch);
      } else {
        const img = pieceImages.get(ch);
        if (img) {
          ctx.drawImage(img,
            boardRect.x + file * sqW + (sqW - pieceSize) / 2,
            boardRect.y + rank * sqH + (sqH - pieceSize) / 2,
            pieceSize, pieceSize);
        }
        file++;
      }
    }
  }

  // Draw animated piece and single-step arrow
  if (pvBoard.anim) {
    const a = pvBoard.anim;
    let srcFile = a.fromSq.charCodeAt(0) - 97;
    let srcRank = 8 - parseInt(a.fromSq[1]);
    let dstFile = a.toSq.charCodeAt(0) - 97;
    let dstRank = 8 - parseInt(a.toSq[1]);
    if (pvBoard.flipped) {
      srcFile = 7 - srcFile; srcRank = 7 - srcRank;
      dstFile = 7 - dstFile; dstRank = 7 - dstRank;
    }

    const t = a.progress;
    const px = boardRect.x + (srcFile + t * (dstFile - srcFile)) * sqW + (sqW - pieceSize) / 2;
    const py = boardRect.y + (srcRank + t * (dstRank - srcRank)) * sqH + (sqH - pieceSize) / 2;
    const img = pieceImages.get(a.piece);
    if (img) {
      ctx.drawImage(img, px, py, pieceSize, pieceSize);
    }

    // Animated arrow (same style as virtual board: no arrowhead, step label)
    const arrowScale = (boardRect.width + boardRect.height) / 2 / 192;
    drawArrow(ctx, {
      from: a.fromSq, to: a.toSq,
      color: a.isWhite ? '#e5e5e5' : '#1a1a1a',
      width: 3, opacity: 0.8, loss_cp: 0,
      label: String(a.step),
    }, boardRect, arrowScale, pvBoard.flipped, 0, t, true);
  }
}

/** Get the arrows to display based on current mode (top moves, PV line, or both) */
export function getActiveArrows(state: OverlayState): ArrowDescriptor[] {
  // Preview mode: show all move arrows but emphasize the selected line's first move
  if (state.pvPreviewLineIndex !== null && state.currentResult?.evaluation?.top_moves?.length) {
    const allArrows = state.currentArrows.filter(a => a.loss_cp <= state.lossThreshold);
    const idx = Math.min(state.pvPreviewLineIndex, state.currentResult.evaluation.top_moves.length - 1);
    const previewMove = state.currentResult.evaluation.top_moves[idx].move;
    const previewFrom = previewMove.slice(0, 2);
    const previewTo = previewMove.slice(2, 4);
    const match = allArrows.find(a => a.from === previewFrom && a.to === previewTo);
    if (match) return [{ ...match, opacity: 1, width: Math.max(match.width, 5) }];
    return [];
  }

  const moveArrows = state.arrowsVisible
    ? state.currentArrows.filter(a => a.loss_cp <= state.lossThreshold)
    : [];
  const pvArrows = (state.lineVisible && state.currentResult?.evaluation?.top_moves?.length)
    ? (() => {
        const idx = Math.min(state.selectedLineIndex, state.currentResult!.evaluation!.top_moves.length - 1);
        const pv = state.currentResult!.evaluation!.top_moves[idx].pv;
        const turn = state.currentResult!.turn
          ?? state.currentResult!.evaluation!.fen?.split(' ')[1] as Turn
          ?? 'w';
        return computePvArrows(pv, turn, state.pvDisplayDepth, state.pvWhiteColor, state.pvBlackColor);
      })()
    : [];
  if (moveArrows.length && pvArrows.length) return [...pvArrows, ...moveArrows];
  return pvArrows.length ? pvArrows : moveArrows;
}

function drawLossLabel(
  ctx: CanvasRenderingContext2D,
  square: string,
  lossCp: number,
  board: { x: number; y: number; width: number; height: number },
  displayFlipped: boolean,
): void {
  const squareW = board.width / 8;
  const squareH = board.height / 8;
  let file = square.charCodeAt(0) - 97;
  let rank = parseInt(square[1], 10) - 1;
  if (displayFlipped) { file = 7 - file; rank = 7 - rank; }

  const text = `−${(lossCp / 100).toFixed(1)}`;
  const fontSize = Math.max(7, Math.round(squareW * 0.28));
  const r = fontSize * 1.3;

  // Position: center of square
  const cx = board.x + (file + 0.5) * squareW;
  const cy = board.y + (7 - rank + 0.5) * squareH;

  ctx.save();
  const color = lossToColor(lossCp);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Contrast text
  const hex = color.replace('#', '');
  const lum = (parseInt(hex.substring(0, 2), 16) * 299 + parseInt(hex.substring(2, 4), 16) * 587 + parseInt(hex.substring(4, 6), 16) * 114) / 1000;
  ctx.globalAlpha = 1;
  ctx.fillStyle = lum > 140 ? '#000' : '#fff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  arrow: ArrowDescriptor,
  board: { x: number; y: number; width: number; height: number },
  widthScale: number,
  displayFlipped: boolean,
  curveOffset: number = 0,
  progress: number = 1,
  noArrowhead: boolean = false,
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
  const fullX2 = board.x + toFile * squareW + squareW / 2;
  const fullY2 = board.y + (7 - toRank) * squareH + squareH / 2;

  // Interpolate endpoint based on progress (0 = at source, 1 = at target)
  const t = Math.min(1, Math.max(0, progress));
  const x2 = x1 + (fullX2 - x1) * t;
  const y2 = y1 + (fullY2 - y1) * t;

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

  // Shorten the curve so it ends before the arrowhead (unless no arrowhead)
  const endX = noArrowhead ? x2 : x2 - headLength * Math.cos(tipAngle);
  const endY = noArrowhead ? y2 : y2 - headLength * Math.sin(tipAngle);

  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  // Gradient stroke: transparent at source, full opacity at tip
  const grad = ctx.createLinearGradient(x1, y1, endX, endY);
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
    ctx.lineTo(endX, endY);
  } else {
    ctx.quadraticCurveTo(mx, my, endX, endY);
  }
  ctx.stroke();

  // Draw the arrowhead at full opacity (unless disabled)
  if (!noArrowhead) {
    ctx.globalAlpha = arrow.opacity;
    ctx.fillStyle = arrow.color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLength * Math.cos(tipAngle - Math.PI / 6), y2 - headLength * Math.sin(tipAngle - Math.PI / 6));
    ctx.lineTo(x2 - headLength * Math.cos(tipAngle + Math.PI / 6), y2 - headLength * Math.sin(tipAngle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  // Draw label at midpoint of arrow (only when fully extended)
  if (arrow.label && t >= 1) {
    const fontSize = Math.max(8, lineWidth * 2);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = arrow.opacity;
    const r = fontSize * 0.55;
    // Midpoint: for curved arrows use the control point, for straight use midpoint
    const ox = curveOffset === 0 ? (x1 + x2) / 2 : mx;
    const oy = curveOffset === 0 ? (y1 + y2) / 2 : my;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fillStyle = arrow.color;
    ctx.fill();
    // Contrast text: dark on light circles, white on dark circles
    const hex = arrow.color.replace('#', '');
    const lum = (parseInt(hex.substring(0, 2), 16) * 299 + parseInt(hex.substring(2, 4), 16) * 587 + parseInt(hex.substring(4, 6), 16) * 114) / 1000;
    ctx.fillStyle = lum > 140 ? '#000' : '#fff';
    ctx.fillText(arrow.label, ox, oy);
  }

  ctx.restore();
}

export function renderArrows(state: OverlayState): void {
  // Skip virtual board arrow rendering while PV playback is animating or vboard overlay hidden
  if ((window as any).__chessrayPvPlaying || !state.vboardOverlayVisible) return;
  if (!state.canvas) return;

  const size = 200;
  const dpr = window.devicePixelRatio || 1;
  // Compensate for CSS transform:scale() on the panel — render at
  // the effective pixel ratio so the canvas stays crisp at any zoom
  const effectiveDpr = dpr * (state.panelScale || 1);
  const bufferSize = Math.ceil(size * effectiveDpr);

  if (state.canvas.width !== bufferSize || state.canvas.height !== bufferSize) {
    state.canvas.width = bufferSize;
    state.canvas.height = bufferSize;
    state.canvas.style.width = `${size}px`;
    state.canvas.style.height = `${size}px`;
  }

  const ctx = state.canvas.getContext('2d')!;
  ctx.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const virtualBoard = { x: 0, y: 0, width: size, height: size };

  // Game over overlay on virtual board
  if (state.currentResult?.game_over) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, size, size);

    const bannerH = size * 0.18;
    const bannerY = (size - bannerH) / 2;
    ctx.fillStyle = state.currentResult.game_over === 'checkmate' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(80, 80, 80, 0.7)';
    ctx.fillRect(0, bannerY, size, bannerH);

    const fontSize = Math.max(10, Math.round(size * 0.07));
    ctx.font = `600 ${fontSize}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(state.currentResult.game_over === 'checkmate' ? 'Checkmate' : 'Stalemate', size / 2, bannerY + bannerH / 2);
    return;
  }

  // Draw played move arrow (behind engine arrows)
  if (state.currentResult?.played_move) {
    const pm = state.currentResult.played_move;
    const pmArrow: ArrowDescriptor = {
      from: pm.from, to: pm.to,
      color: lossToColor(pm.loss_cp),
      width: 3, opacity: 0.5,
      loss_cp: pm.loss_cp,
    };
    drawArrow(ctx, pmArrow, virtualBoard, 1, state.displayFlipped);
    if (pm.loss_cp >= state.playedLossThreshold) {
      drawLossLabel(ctx, pm.from, pm.loss_cp, virtualBoard, state.displayFlipped);
    }
  }

  const targetArrows = getActiveArrows(state);

  if (targetArrows.length === 0 && !state.currentResult?.played_move) {
    vboardArrowState.animated = [];
    if (vboardArrowState.timer) { clearInterval(vboardArrowState.timer); vboardArrowState.timer = 0; }
    return;
  }

  const animated = updateAnimatedArrows(targetArrows, vboardArrowState, () => renderArrows(state));
  const drawList = animated.map(a => ({ arrow: { ...a, opacity: a.fadeOpacity }, progress: a.progress }));

  const offsets = computeCurveOffsets(drawList.map(d => d.arrow));
  for (let i = drawList.length - 1; i >= 0; i--) {
    const isLineArrow = !!drawList[i].arrow.label;
    drawArrow(ctx, drawList[i].arrow, virtualBoard, 1, state.displayFlipped, offsets[i], drawList[i].progress, isLineArrow);
  }

  // Draw cp loss label for the active PV line
  if (state.lineVisible && state.pvDisplayDepth > 0 && state.currentResult?.evaluation?.top_moves?.length) {
    const idx = Math.min(state.selectedLineIndex, state.currentResult.evaluation.top_moves.length - 1);
    const move = state.currentResult.evaluation.top_moves[idx];
    if (move.loss_cp >= 5 && targetArrows[0]) {
      drawLossLabel(ctx, targetArrows[0].from, move.loss_cp, virtualBoard, state.displayFlipped);
    }
  }

  // Draw cp loss label during preview mode on the highlighted arrow
  if (state.pvPreviewLineIndex !== null && state.currentResult?.evaluation?.top_moves?.length) {
    const idx = Math.min(state.pvPreviewLineIndex, state.currentResult.evaluation.top_moves.length - 1);
    const move = state.currentResult.evaluation.top_moves[idx];
    if (move.loss_cp >= 5) {
      const from = move.move.slice(0, 2);
      drawLossLabel(ctx, from, move.loss_cp, virtualBoard, state.displayFlipped);
    }
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
  // The overlay window may be offset from the top of the display (e.g. macOS
  // menu bar pushes it down). Compute the offset relative to the display origin,
  // not the absolute screen position (which differs on secondary monitors).
  const dpr = state.displayInfo?.scaleFactor ?? window.devicePixelRatio;
  const overlayY = state.displayInfo?.overlayBounds?.y ?? 0;
  const displayY = state.displayInfo?.displayBounds?.y ?? 0;
  const overlayYOffset = overlayY - displayY;

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

  // During PV animation, draw analysis board (background + pieces + animated arrow)
  if (state.pvBoardState) {
    drawAnalysisBoard(ctx, boardRect, state.pvBoardState);
    // Clear normal arrow animation state while analysis board is active
    videoArrowState.animated = [];
    if (videoArrowState.timer) { clearInterval(videoArrowState.timer); videoArrowState.timer = 0; }
  } else {
    // Draw played move arrow (behind engine arrows)
    if (result.played_move) {
      const pm = result.played_move;
      const pmArrow: ArrowDescriptor = {
        from: pm.from, to: pm.to,
        color: lossToColor(pm.loss_cp),
        width: 3, opacity: 0.5,
        loss_cp: pm.loss_cp,
      };
      const arrowScale = (bw + bh) / 2 / 192;
      drawArrow(ctx, pmArrow, boardRect, arrowScale, state.displayFlipped);
      if (pm.loss_cp >= state.playedLossThreshold) {
        drawLossLabel(ctx, pm.from, pm.loss_cp, boardRect, state.displayFlipped);
      }
    }

    if (state.arrowsVisible || state.lineVisible || state.pvPreviewLineIndex !== null) {
      const targetArrows = getActiveArrows(state);
      const animated = updateAnimatedArrows(targetArrows, videoArrowState, () => renderVideoOverlay(state));
      // Draw with animated opacity
      const drawList = animated.map(a => ({ arrow: { ...a, opacity: a.fadeOpacity }, progress: a.progress }));
      const arrowScale = (bw + bh) / 2 / 192;

      const offsets = computeCurveOffsets(drawList.map(d => d.arrow));
      for (let i = drawList.length - 1; i >= 0; i--) {
        drawArrow(ctx, drawList[i].arrow, boardRect, arrowScale, state.displayFlipped, offsets[i], drawList[i].progress);
      }

      // Draw cp loss label for the active PV line
      if (state.lineVisible && state.pvDisplayDepth > 0 && result.evaluation?.top_moves?.length) {
        const idx = Math.min(state.selectedLineIndex, result.evaluation.top_moves.length - 1);
        const move = result.evaluation.top_moves[idx];
        if (move.loss_cp >= 5) {
          const firstArrow = targetArrows[0];
          if (firstArrow) {
            drawLossLabel(ctx, firstArrow.from, move.loss_cp, boardRect, state.displayFlipped);
          }
        }
      }

      // Draw cp loss label during preview mode on the highlighted arrow
      if (state.pvPreviewLineIndex !== null && result.evaluation?.top_moves?.length) {
        const idx = Math.min(state.pvPreviewLineIndex, result.evaluation.top_moves.length - 1);
        const move = result.evaluation.top_moves[idx];
        if (move.loss_cp >= 5) {
          const from = move.move.slice(0, 2);
          drawLossLabel(ctx, from, move.loss_cp, boardRect, state.displayFlipped);
        }
      }
    } else {
      // Clear animation state when arrows are hidden
      videoArrowState.animated = [];
      if (videoArrowState.timer) { clearInterval(videoArrowState.timer); videoArrowState.timer = 0; }
    }
  }

  // Eval bar (semi-transparent when showing stale eval from previous position)
  if (state.evalBarVisible && result.evaluation?.top_moves?.length) {
    const isStale = !!result.stale_eval;
    ctx.save();
    if (isStale) ctx.globalAlpha = 0.65;

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
    ctx.restore();
  }

  // Game over overlay on the actual board
  if (result.game_over) {
    // Semi-transparent dark overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(bx, by, bw, bh);

    // Banner in the center
    const bannerH = bh * 0.18;
    const bannerY = by + (bh - bannerH) / 2;
    ctx.fillStyle = result.game_over === 'checkmate' ? 'rgba(0, 0, 0, 0.75)' : 'rgba(80, 80, 80, 0.75)';
    ctx.fillRect(bx, bannerY, bw, bannerH);

    // Text
    const fontSize = Math.max(14, Math.round(bw * 0.06));
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';

    const text = result.game_over === 'checkmate'
      ? `Checkmate — ${result.turn === 'w' ? 'Black' : 'White'} wins`
      : 'Stalemate — Draw';
    ctx.fillText(text, bx + bw / 2, bannerY + bannerH / 2);
  }
}

export function clearVideoOverlay(state: OverlayState): void {
  if (!state.videoCanvas) return;
  const ctx = state.videoCanvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, state.videoCanvas.width, state.videoCanvas.height);
}
