import type { ArrowDescriptor, PipelineResult } from '../shared/types.js';
import { computeCurveOffsets, lossToColor } from '../shared/arrows.js';
import { rgbToCss, squareColorPalette, type RGB } from '../shared/colors.js';
import { pieceImages } from './piece-svg.js';

export interface PvBoardState {
  fen: string;           // Current board FEN (piece placement only)
  flipped: boolean;
  highlight: number[];   // Highlighted square indices (in non-flipped coordinate space)
  /** Detected square colors of the real board, used to theme the analysis board */
  squareColors?: { light: RGB; dark: RGB };
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
  evalBarVisible: boolean;
  sourceVisible: boolean;
  selectedLineIndex: number;
  lossThreshold: number;
  vboardOverlayVisible: boolean;
  pvPreviewLineIndex: number | null;
  pvBoardState: PvBoardState | null;
  /** Line index of the arrow currently under the mouse (either canvas), or null.
   *  Drives hover emphasis: hovered arrow → opacity 1.0, others → dimmed. */
  hoveredArrowIndex: number | null;
  panelScale: number;
  boardScale: number;
  displayInfo: {
    size: { width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
    overlayBounds?: { x: number; y: number; width: number; height: number };
    displayBounds?: { x: number; y: number; width: number; height: number };
  } | null;
}

// ── Hit-test caches ──
// Each render pass populates these so mouse handlers can map (x,y) → line index.
// Stored in the canvas's own coordinate space (CSS pixels for video overlay,
// 200×200 logical space for the virtual board canvas).
export interface ArrowHitShape {
  lineIndex: number;
  x1: number; y1: number;
  mx: number; my: number;   // bezier control point (equals midpoint when straight)
  x2: number; y2: number;
  lineWidth: number;
  curved: boolean;
}
export interface HitCache {
  arrows: ArrowHitShape[];
  /** Board rect (canvas coords) to hit-test for "click to stop animation".
   *  Non-null only while a PV animation is active on this canvas. */
  animBoardRect: { x: number; y: number; width: number; height: number } | null;
}
export const videoHitCache: HitCache = { arrows: [], animBoardRect: null };
export const vboardHitCache: HitCache = { arrows: [], animBoardRect: null };

function distPointToSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Return the hovered line index for (px, py) in canvas-local coords, or null. */
export function hitTestArrows(cache: HitCache, px: number, py: number): number | null {
  let bestIdx: number | null = null;
  let bestDist = Infinity;
  for (const s of cache.arrows) {
    const tol = s.lineWidth / 2 + 6;
    let d: number;
    if (!s.curved) {
      d = distPointToSegment(px, py, s.x1, s.y1, s.x2, s.y2);
    } else {
      // Quadratic bezier: sample and take min distance to segment polyline
      d = Infinity;
      const steps = 16;
      let prevX = s.x1, prevY = s.y1;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const ix = u * u * s.x1 + 2 * u * t * s.mx + t * t * s.x2;
        const iy = u * u * s.y1 + 2 * u * t * s.my + t * t * s.y2;
        const dd = distPointToSegment(px, py, prevX, prevY, ix, iy);
        if (dd < d) d = dd;
        prevX = ix; prevY = iy;
      }
    }
    if (d <= tol && d < bestDist) {
      bestDist = d;
      bestIdx = s.lineIndex;
    }
  }
  return bestIdx;
}

export function hitTestAnimBoard(cache: HitCache, px: number, py: number): boolean {
  const r = cache.animBoardRect;
  if (!r) return false;
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
}

/** Compute the same geometry drawArrow uses, so the render loop can push a
 *  hit-test shape without duplicating the math in callers. */
function computeArrowHitShape(
  arrow: ArrowDescriptor,
  board: { x: number; y: number; width: number; height: number },
  widthScale: number,
  displayFlipped: boolean,
  curveOffset: number,
  lineIndex: number,
): ArrowHitShape {
  const squareW = board.width / 8;
  const squareH = board.height / 8;
  let fromFile = arrow.from.charCodeAt(0) - 97;
  let fromRank = parseInt(arrow.from[1], 10) - 1;
  let toFile = arrow.to.charCodeAt(0) - 97;
  let toRank = parseInt(arrow.to[1], 10) - 1;
  if (displayFlipped) {
    fromFile = 7 - fromFile; fromRank = 7 - fromRank;
    toFile = 7 - toFile; toRank = 7 - toRank;
  }
  const x1 = board.x + fromFile * squareW + squareW / 2;
  const y1 = board.y + (7 - fromRank) * squareH + squareH / 2;
  const x2 = board.x + toFile * squareW + squareW / 2;
  const y2 = board.y + (7 - toRank) * squareH + squareH / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const perpX = len > 0 ? -dy / len : 0;
  const perpY = len > 0 ? dx / len : 0;
  const offsetPx = curveOffset * (squareW + squareH) / 2;
  const mx = (x1 + x2) / 2 + perpX * offsetPx;
  const my = (y1 + y2) / 2 + perpY * offsetPx;
  return {
    lineIndex, x1, y1, mx, my, x2, y2,
    lineWidth: arrow.width * widthScale,
    curved: curveOffset !== 0,
  };
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

// ── Eval bar disappearance trace ──
// Logs ONLY when the visible state changes (drawn → gone or gone → drawn) so
// the log isn't spammed. Each transition records why the bar wasn't drawn.
let lastVideoEvalDrawn: boolean | null = null;
let lastVboardEvalDrawn: boolean | null = null;
function logEvalBarTransition(
  scope: 'video' | 'vboard',
  drawn: boolean,
  reason: string,
): void {
  const prev = scope === 'video' ? lastVideoEvalDrawn : lastVboardEvalDrawn;
  if (prev === drawn) return;
  if (scope === 'video') lastVideoEvalDrawn = drawn; else lastVboardEvalDrawn = drawn;
  const msg = `eval-bar[${scope}]: ${drawn ? 'DRAWN' : 'GONE'} (${reason})`;
  try {
    (window as any).chessRay?.sendDebugLog?.(msg);
  } catch { /* ignore */ }
  console.log(`[chessray] ${msg}`);
}

// ── Video-overlay eval bar tween ──
// The bar's winProb is animated from current → target over EVAL_BAR_TWEEN_MS
// using a cubic ease-out. Without this the bar snaps as eval depths arrive.
const EVAL_BAR_TWEEN_MS = 350;
const evalBarAnim = {
  /** Currently displayed winProb (0..1). Used by renderVideoOverlay's draw call. */
  current: 0.5,
  /** Most recent target winProb. The tween eases from `start` toward this. */
  target: 0.5,
  /** Snapshot of `current` at the start of the active tween (so we can lerp
   *  with the same start value across frames, not jump ahead). */
  start: 0.5,
  /** Wall time when the active tween began. */
  startTs: 0,
  /** rAF/interval handle for the active tween. 0 when no tween is running. */
  timer: 0 as any,
};
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function tickEvalBar(state: OverlayState): void {
  const elapsed = Date.now() - evalBarAnim.startTs;
  const t = Math.min(1, elapsed / EVAL_BAR_TWEEN_MS);
  evalBarAnim.current = evalBarAnim.start + (evalBarAnim.target - evalBarAnim.start) * easeOutCubic(t);
  if (t >= 1) {
    if (evalBarAnim.timer) { clearInterval(evalBarAnim.timer); evalBarAnim.timer = 0; }
  }
  renderVideoOverlay(state);
}
function setEvalBarTarget(state: OverlayState, target: number): void {
  if (Math.abs(target - evalBarAnim.target) < 0.001) return;
  evalBarAnim.start = evalBarAnim.current;
  evalBarAnim.target = target;
  evalBarAnim.startTs = Date.now();
  if (!evalBarAnim.timer) {
    evalBarAnim.timer = setInterval(() => tickEvalBar(state), 16);
  }
}

// ── PV preview emphasis ──
// The previewed move's line uses a spatial sine bell (0 → peak → 0 along the
// length) AND its overall opacity (line + loss circle) is multiplied by a
// half-sine pulse over time. Other arrows render normally.
const PV_PULSE_MS = 1600;
function pulseFactor(): number {
  const t = (Date.now() % PV_PULSE_MS) / PV_PULSE_MS;
  return Math.sin(Math.PI * t); // 0 → 1 → 0
}
const pulseTimers = { vboard: 0 as any, video: 0 as any };
function ensurePulseTimer(
  key: 'vboard' | 'video',
  active: boolean,
  onTick: () => void,
): void {
  if (active && !pulseTimers[key]) {
    pulseTimers[key] = setInterval(onTick, 33);
  } else if (!active && pulseTimers[key]) {
    clearInterval(pulseTimers[key]);
    pulseTimers[key] = 0;
  }
}

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

/** Draw analysis board (background + pieces + animated piece + arrow) on the video overlay canvas */
function drawAnalysisBoard(
  ctx: CanvasRenderingContext2D,
  boardRect: { x: number; y: number; width: number; height: number },
  pvBoard: PvBoardState,
): void {
  const sqW = boardRect.width / 8;
  const sqH = boardRect.height / 8;
  const hlSet = new Set(pvBoard.flipped ? pvBoard.highlight.map(i => 63 - i) : pvBoard.highlight);
  const palette = squareColorPalette(pvBoard.squareColors, { analysis: true });

  // Draw colored squares
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const idx = rank * 8 + file;
      const isLight = (rank + file) % 2 === 0;
      const isHl = hlSet.has(idx);
      ctx.fillStyle = rgbToCss(isHl
        ? (isLight ? palette.lightHl : palette.darkHl)
        : (isLight ? palette.light : palette.dark));
      ctx.fillRect(boardRect.x + file * sqW, boardRect.y + rank * sqH, sqW, sqH);
    }
  }

  // Parse FEN and draw pieces
  let fenRows = pvBoard.fen.split('/');
  if (pvBoard.flipped) {
    fenRows = fenRows.reverse().map(r => r.split('').reverse().join(''));
  }
  const pieceSize = Math.min(sqW, sqH) * 0.88;

  // Identify the captured piece (if any) so we can skip it in the static draw
  // and overlay it with a fade-out opacity tied to animation progress.
  let capturedSqRank = -1, capturedSqFile = -1, capturedPieceCh = '';
  if (pvBoard.anim) {
    let dstFileRaw = pvBoard.anim.toSq.charCodeAt(0) - 97;
    let dstRankRaw = 8 - parseInt(pvBoard.anim.toSq[1]);
    if (pvBoard.flipped) { dstFileRaw = 7 - dstFileRaw; dstRankRaw = 7 - dstRankRaw; }
    const row = fenRows[dstRankRaw];
    if (row) {
      let f = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') { f += parseInt(ch); }
        else {
          if (f === dstFileRaw) { capturedPieceCh = ch; capturedSqRank = dstRankRaw; capturedSqFile = dstFileRaw; }
          f++;
        }
      }
    }
  }

  for (let rank = 0; rank < fenRows.length; rank++) {
    let file = 0;
    for (const ch of fenRows[rank]) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch);
      } else {
        // Skip the captured piece here — it's drawn separately below with a
        // fade-out alpha so the new piece doesn't appear to land on top of it.
        const isCaptured = rank === capturedSqRank && file === capturedSqFile && ch === capturedPieceCh;
        if (!isCaptured) {
          const img = pieceImages.get(ch);
          if (img) {
            ctx.drawImage(img,
              boardRect.x + file * sqW + (sqW - pieceSize) / 2,
              boardRect.y + rank * sqH + (sqH - pieceSize) / 2,
              pieceSize, pieceSize);
          }
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

    // Captured piece fades out linearly with the slide.
    if (capturedPieceCh) {
      const capImg = pieceImages.get(capturedPieceCh);
      if (capImg) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.drawImage(capImg,
          boardRect.x + capturedSqFile * sqW + (sqW - pieceSize) / 2,
          boardRect.y + capturedSqRank * sqH + (sqH - pieceSize) / 2,
          pieceSize, pieceSize);
        ctx.restore();
      }
    }

    const px = boardRect.x + (srcFile + t * (dstFile - srcFile)) * sqW + (sqW - pieceSize) / 2;
    const py = boardRect.y + (srcRank + t * (dstRank - srcRank)) * sqH + (sqH - pieceSize) / 2;
    const img = pieceImages.get(a.piece);
    if (img) {
      ctx.drawImage(img, px, py, pieceSize, pieceSize);
    }

    // Animated arrow — same style as virtual board (no arrowhead, step label).
    // Opacity follows a sine bell so the arrow fades in, peaks at mid-movement,
    // and fades back out as the piece settles.
    const arrowScale = (boardRect.width + boardRect.height) / 2 / 192;
    const bellOpacity = 0.8 * Math.sin(Math.PI * t);
    drawArrow(ctx, {
      from: a.fromSq, to: a.toSq,
      color: a.isWhite ? '#e5e5e5' : '#1a1a1a',
      width: 3, opacity: bellOpacity, loss_cp: 0,
      label: String(a.step),
    }, boardRect, arrowScale, pvBoard.flipped, 0, t, true);
  }
}

/** Arrows to display. In preview mode only the previewed move is shown —
 *  it's drawn separately on top with bell + pulse emphasis (no arrowhead;
 *  the loss circle anchors the destination), so we return no underlying
 *  arrows and let the preview layer carry the whole visual. */
export function getActiveArrows(state: OverlayState): ArrowDescriptor[] {
  if (state.pvPreviewLineIndex !== null) return [];
  const filtered = state.currentArrows.filter(a => a.loss_cp <= state.lossThreshold);
  return state.arrowsVisible ? filtered : [];
}

/** Resolve the previewed move's arrow (always returned regardless of
 *  lossThreshold so the user-selected line is never hidden). Bumps width
 *  and clamps base opacity to 1.0 so the pulse can reach full intensity. */
function getPreviewArrow(state: OverlayState): ArrowDescriptor | null {
  if (state.pvPreviewLineIndex === null) return null;
  const moves = state.currentResult?.evaluation?.top_moves;
  if (!moves?.length) return null;
  const idx = Math.min(state.pvPreviewLineIndex, moves.length - 1);
  const previewMove = moves[idx].move;
  const previewFrom = previewMove.slice(0, 2);
  const previewTo = previewMove.slice(2, 4);
  const match = state.currentArrows.find(a => a.from === previewFrom && a.to === previewTo);
  if (match) return { ...match, opacity: 1, width: Math.max(match.width, 5) };
  return null;
}

/** Draw a small colored badge on the target square of the played move (overlaid on
 * the piece). Color encodes centipawn loss, and the loss value is shown inside. */
function drawPlayedMoveMarker(
  ctx: CanvasRenderingContext2D,
  square: string,
  lossCp: number,
  board: { x: number; y: number; width: number; height: number },
  displayFlipped: boolean,
  /** Multiplied into every globalAlpha so the marker can pulse in lockstep
   *  with the previewed line (1 = unchanged). */
  opacityMul: number = 1,
): void {
  const squareW = board.width / 8;
  const squareH = board.height / 8;
  let file = square.charCodeAt(0) - 97;
  let rank = parseInt(square[1], 10) - 1;
  if (displayFlipped) { file = 7 - file; rank = 7 - rank; }

  const cx = board.x + (file + 0.5) * squareW;
  const cy = board.y + (7 - rank + 0.5) * squareH;

  if (lossCp < 10) {
    // Excellent move — white checkmark inside a translucent green disk
    const r = Math.min(squareW, squareH) * 0.22;
    const size = r * 1.25;
    const strokeW = Math.max(2, r * 0.28);

    ctx.save();
    ctx.globalAlpha = 0.5 * opacityMul;
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.55 * opacityMul;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.45, cy + size * 0.05);
    ctx.lineTo(cx - size * 0.10, cy + size * 0.35);
    ctx.lineTo(cx + size * 0.50, cy - size * 0.35);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Loss badge — colored disk with centipawn loss text inside
  const fontSize = Math.max(7, Math.round(Math.min(squareW, squareH) * 0.20));
  const r = fontSize * 1.25;
  const color = lossToColor(lossCp);

  ctx.save();
  ctx.globalAlpha = 0.7 * opacityMul;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Translucent white loss text with black outline for legibility
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = `−${(lossCp / 100).toFixed(1)}`;
  ctx.globalAlpha = 1 * opacityMul;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, fontSize * 0.18);
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = '#fff';
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
  /** Replace linear (transparent→opaque) gradient with a sine bell along the
   *  line: 0 at source → peak (= arrow.opacity) at midpoint → 0 at tip.
   *  Used for the PV preview arrow. */
  bellGradient: boolean = false,
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
  const wStart = Math.max(lineWidth * 0.2, 1.5);
  const wTip = wStart + (lineWidth - wStart) * t;
  // Head length scales with the current tip width so that during fade-in
  // (small progress → thin tip) the head stays proportional and can't pull
  // endX,endY behind the source.
  const headLength = wTip * 3;

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
  const r = parseInt(arrow.color.slice(1, 3), 16);
  const g = parseInt(arrow.color.slice(3, 5), 16);
  const b = parseInt(arrow.color.slice(5, 7), 16);

  if (bellGradient) {
    // Preview mode — keep the stroked bell-gradient line. The tapered ribbon
    // wouldn't compose with the spatial bell pulse, and the preview is a
    // distinct emphasis mode anyway.
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    const grad = ctx.createLinearGradient(x1, y1, endX, endY);
    const stops = 9;
    for (let i = 0; i <= stops; i++) {
      const u = i / stops;
      const w = Math.sin(Math.PI * u); // 0 → 1 → 0
      grad.addColorStop(u, `rgba(${r},${g},${b},${(arrow.opacity * w).toFixed(3)})`);
    }
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    if (curveOffset === 0) ctx.lineTo(endX, endY);
    else ctx.quadraticCurveTo(mx, my, endX, endY);
    ctx.stroke();
  } else {
    // Tapered ribbon — filled polygon that grows in width from thin at the
    // source to full at the tip. Uniform alpha (color carries quality; width
    // carries rank; the taper itself is the direction cue).
    // wStart / wTip declared above drive both the ribbon and the scaled head.
    const segs = curveOffset === 0
      ? 2
      : Math.max(12, Math.round(Math.hypot(endX - x1, endY - y1) / 6));

    const pointAt = (s: number): { x: number; y: number; nx: number; ny: number } => {
      // s in [0,1] along the (possibly curved) shaft from source to endX,endY
      let sx: number, sy: number, tx: number, ty: number;
      if (curveOffset === 0) {
        sx = x1 + (endX - x1) * s;
        sy = y1 + (endY - y1) * s;
        tx = endX - x1;
        ty = endY - y1;
      } else {
        const u = 1 - s;
        sx = u * u * x1 + 2 * u * s * mx + s * s * endX;
        sy = u * u * y1 + 2 * u * s * my + s * s * endY;
        tx = 2 * u * (mx - x1) + 2 * s * (endX - mx);
        ty = 2 * u * (my - y1) + 2 * s * (endY - my);
      }
      const mag = Math.hypot(tx, ty) || 1;
      return { x: sx, y: sy, nx: -ty / mag, ny: tx / mag };
    };

    ctx.globalAlpha = arrow.opacity;
    ctx.fillStyle = `rgb(${r},${g},${b})`;

    ctx.beginPath();
    // Left edge: source → tip, width ramping wStart → wTip
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      const w = (wStart + (wTip - wStart) * s) / 2;
      const p = pointAt(s);
      const lx = p.x + p.nx * w, ly = p.y + p.ny * w;
      if (i === 0) ctx.moveTo(lx, ly);
      else ctx.lineTo(lx, ly);
    }
    // Right edge: tip → source
    for (let i = segs; i >= 0; i--) {
      const s = i / segs;
      const w = (wStart + (wTip - wStart) * s) / 2;
      const p = pointAt(s);
      const rx = p.x - p.nx * w, ry = p.y - p.ny * w;
      ctx.lineTo(rx, ry);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Arrowhead — same length as the gap between x2,y2 and endX,endY (headLength
  // was computed from the current tip width, so head and ribbon stay in sync).
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
  // Skip virtual board arrow rendering while PV playback is animating or vboard overlay hidden.
  // When PV is playing, repurpose the vboard hit cache so clicking the virtual
  // board canvas resets the animation (symmetric with actual-board click-to-stop).
  if ((window as any).__chessrayPvPlaying) {
    vboardHitCache.arrows = [];
    vboardHitCache.animBoardRect = { x: 0, y: 0, width: 200, height: 200 };
    return;
  }
  if (!state.vboardOverlayVisible) {
    vboardHitCache.arrows = [];
    vboardHitCache.animBoardRect = null;
    return;
  }
  if (!state.canvas) return;

  const size = 200;
  const dpr = window.devicePixelRatio || 1;
  // Compensate for both CSS transforms stacking on this canvas: the outer
  // panel's panelScale and the inner .board-container's --board-scale.
  // Without boardScale the canvas upscales as a bitmap when the board leaf
  // is larger than 200px, pixelating arrows/circles.
  const effectiveDpr = dpr * (state.panelScale || 1) * (state.boardScale || 1);
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

  // Mark the played move's target square (on the moved piece) with a loss-colored dot
  if (state.currentResult?.played_move) {
    const pm = state.currentResult.played_move;
    drawPlayedMoveMarker(ctx, pm.to, pm.loss_cp, virtualBoard, state.displayFlipped);
  }

  const targetArrows = getActiveArrows(state);
  const isPreview = state.pvPreviewLineIndex !== null;

  if (targetArrows.length === 0 && !state.currentResult?.played_move && !isPreview) {
    // Nothing to draw, but keep `.animated` intact so arrows that return later
    // (e.g. after playback, loss-threshold change, visibility toggle) are
    // matched by from-to and stay steady instead of re-growing from source.
    if (vboardArrowState.timer) { clearInterval(vboardArrowState.timer); vboardArrowState.timer = 0; }
    ensurePulseTimer('vboard', false, () => renderArrows(state));
    vboardHitCache.arrows = [];
    vboardHitCache.animBoardRect = null;
    return;
  }

  const animated = updateAnimatedArrows(targetArrows, vboardArrowState, () => renderArrows(state));
  const drawList = animated.map(a => ({ arrow: { ...a, opacity: a.fadeOpacity }, progress: a.progress }));

  const offsets = computeCurveOffsets(drawList.map(d => d.arrow));
  vboardHitCache.arrows = [];
  vboardHitCache.animBoardRect = null;
  const hoveredIdx = state.hoveredArrowIndex;
  for (let i = drawList.length - 1; i >= 0; i--) {
    const isLineArrow = !!drawList[i].arrow.label;
    const arrow = drawList[i].arrow;
    const lineIdx = state.currentArrows.findIndex(a => a.from === arrow.from && a.to === arrow.to);
    let effectiveOpacity = arrow.opacity;
    if (hoveredIdx !== null && lineIdx >= 0) {
      if (lineIdx === hoveredIdx) effectiveOpacity = 1.0;
      else effectiveOpacity = arrow.opacity * 0.25;
    }
    drawArrow(ctx, { ...arrow, opacity: effectiveOpacity }, virtualBoard, 1, state.displayFlipped, offsets[i], drawList[i].progress, isLineArrow);
    if (lineIdx >= 0 && drawList[i].progress >= 1) {
      vboardHitCache.arrows.push(computeArrowHitShape(arrow, virtualBoard, 1, state.displayFlipped, offsets[i], lineIdx));
    }
  }

  // Preview emphasis: bell-gradient line + pulsing loss circle, half-sine envelope.
  // Drawn on top of the normal arrows; other arrows render unchanged.
  ensurePulseTimer('vboard', isPreview, () => renderArrows(state));
  if (isPreview) {
    const previewArrow = getPreviewArrow(state);
    if (previewArrow && state.currentResult?.evaluation?.top_moves?.length) {
      const pulse = pulseFactor();
      drawArrow(
        ctx,
        { ...previewArrow, opacity: previewArrow.opacity * pulse },
        virtualBoard, 1, state.displayFlipped,
        0, 1, true /* noArrowhead */, true /* bellGradient */,
      );
      const moves = state.currentResult.evaluation.top_moves;
      const idx = Math.min(state.pvPreviewLineIndex!, moves.length - 1);
      const move = moves[idx];
      const to = move.move.slice(2, 4);
      drawPlayedMoveMarker(ctx, to, move.loss_cp, virtualBoard, state.displayFlipped, pulse);
    }
  }
}

/** Draw arrows and eval bar on the full-screen overlay canvas */
export function renderVideoOverlay(state: OverlayState): void {
  if (!state.videoCanvas) return;
  const ctx = state.videoCanvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, state.videoCanvas.width, state.videoCanvas.height);

  if (!state.sourceVisible) {
    logEvalBarTransition('video', false, 'sourceVisible=false (overlay canvas cleared)');
    return;
  }

  const result = state.currentResult;
  if (!result?.board_detection?.found || !result.board_detection.bbox || !result.frame_dimensions) {
    const why = !result ? 'no result'
      : !result.board_detection?.found ? 'board not found'
      : !result.board_detection.bbox ? 'bbox=null'
      : 'frame_dimensions=null';
    logEvalBarTransition('video', false, `early return: ${why}`);
    return;
  }
  // Gate the entire actual-board overlay on recognition confidence. Matches
  // the analysis pipeline's own low-confidence threshold (0.3) so that a
  // transient misread doesn't paint arrows/eval-bar over a board we can't
  // actually read. Canvas was cleared above, so returning here hides the overlay.
  const recogConfidence = result.recognition?.confidence ?? 0;
  if (recogConfidence < 0.3) {
    videoHitCache.arrows = [];
    videoHitCache.animBoardRect = null;
    if (videoArrowState.timer) { clearInterval(videoArrowState.timer); videoArrowState.timer = 0; }
    ensurePulseTimer('video', false, () => renderVideoOverlay(state));
    logEvalBarTransition('video', false, `low confidence: ${(recogConfidence * 100).toFixed(0)}%`);
    return;
  }

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
    // Pause the fade timer while the analysis board is active, but keep
    // `.animated` intact so that when playback ends the same arrows re-appear
    // at progress=1 (steady) instead of re-growing from source.
    if (videoArrowState.timer) { clearInterval(videoArrowState.timer); videoArrowState.timer = 0; }
    // Arrows aren't visible during animation — hit-test the board region instead
    // so a click anywhere on the animated board resets the animation.
    videoHitCache.arrows = [];
    videoHitCache.animBoardRect = { x: bx, y: by, width: bw, height: bh };
  } else {
    videoHitCache.animBoardRect = null;
    // Mark the played move's target square (on the moved piece) with a loss-colored dot
    if (result.played_move) {
      const pm = result.played_move;
      drawPlayedMoveMarker(ctx, pm.to, pm.loss_cp, boardRect, state.displayFlipped);
    }

    if (state.arrowsVisible || state.pvPreviewLineIndex !== null) {
      const targetArrows = getActiveArrows(state);
      const animated = updateAnimatedArrows(targetArrows, videoArrowState, () => renderVideoOverlay(state));
      const drawList = animated.map(a => ({ arrow: { ...a, opacity: a.fadeOpacity }, progress: a.progress }));
      const arrowScale = (bw + bh) / 2 / 192;
      const isPreview = state.pvPreviewLineIndex !== null;
      const offsets = computeCurveOffsets(drawList.map(d => d.arrow));
      videoHitCache.arrows = [];
      const hoveredIdx = state.hoveredArrowIndex;
      for (let i = drawList.length - 1; i >= 0; i--) {
        const arrow = drawList[i].arrow;
        const lineIdx = state.currentArrows.findIndex(a => a.from === arrow.from && a.to === arrow.to);
        let effectiveOpacity = arrow.opacity;
        if (hoveredIdx !== null && lineIdx >= 0) {
          if (lineIdx === hoveredIdx) effectiveOpacity = 1.0;
          else effectiveOpacity = arrow.opacity * 0.25;
        }
        drawArrow(ctx, { ...arrow, opacity: effectiveOpacity }, boardRect, arrowScale, state.displayFlipped, offsets[i], drawList[i].progress, false);
        if (lineIdx >= 0 && drawList[i].progress >= 1) {
          videoHitCache.arrows.push(computeArrowHitShape(arrow, boardRect, arrowScale, state.displayFlipped, offsets[i], lineIdx));
        }
      }

      // Preview emphasis: bell-gradient line + pulsing loss circle, half-sine envelope.
      // Other arrows above render unchanged.
      ensurePulseTimer('video', isPreview, () => renderVideoOverlay(state));
      if (isPreview) {
        const previewArrow = getPreviewArrow(state);
        if (previewArrow && result.evaluation?.top_moves?.length) {
          const pulse = pulseFactor();
          drawArrow(
            ctx,
            { ...previewArrow, opacity: previewArrow.opacity * pulse },
            boardRect, arrowScale, state.displayFlipped,
            0, 1, true /* noArrowhead */, true /* bellGradient */,
          );
          const idx = Math.min(state.pvPreviewLineIndex!, result.evaluation.top_moves.length - 1);
          const move = result.evaluation.top_moves[idx];
          const to = move.move.slice(2, 4);
          drawPlayedMoveMarker(ctx, to, move.loss_cp, boardRect, state.displayFlipped, pulse);
        }
      }
    } else {
      // Arrows hidden (e.g. during the brief gap between PV steps, or while
      // arrowsVisible=false with no preview). Pause the fade timer but keep
      // `.animated` so the same arrows resume steady when they reappear.
      if (videoArrowState.timer) { clearInterval(videoArrowState.timer); videoArrowState.timer = 0; }
      ensurePulseTimer('video', false, () => renderVideoOverlay(state));
      videoHitCache.arrows = [];
    }
  }

  // Eval bar (semi-transparent when showing stale eval from previous position)
  // Disappearance trace: log only the transition when the bar's visibility
  // actually flips so we can see exactly why it went missing.
  {
    const drawable = !!(state.evalBarVisible && result.evaluation?.top_moves?.length);
    if (!drawable) {
      const reason = !state.evalBarVisible ? 'evalBarVisible=false'
        : !result.evaluation ? 'evaluation=null'
        : `top_moves=${result.evaluation.top_moves?.length ?? 0}`;
      logEvalBarTransition('video', false, `${reason} status=${result.detection_status ?? '-'} stale=${!!result.stale_eval}`);
    } else {
      logEvalBarTransition('video', true, `stale=${!!result.stale_eval} depth=${result.eval_depth ?? '-'} status=${result.detection_status ?? '-'}`);
    }
  }

  if (state.evalBarVisible && result.evaluation?.top_moves?.length) {
    const isStale = !!result.stale_eval;
    ctx.save();
    if (isStale) ctx.globalAlpha = 0.65;

    const sideScore = result.evaluation.top_moves[0].score_cp;
    const turn = result.evaluation.fen?.split(' ')[1] || 'w';
    const bestScore = turn === 'b' ? -sideScore : sideScore;
    const targetWinProb = 1 / (1 + Math.pow(10, -bestScore / 400));
    setEvalBarTarget(state, targetWinProb);
    const winProb = evalBarAnim.current;

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

/** Snap-clear video overlay arrow animations. Use when the underlying position
 * changes, so old PV arrows disappear instantly instead of fading out over the
 * new position's squares. */
export function resetVideoArrowAnimation(): void {
  videoArrowState.animated = [];
  if (videoArrowState.timer) {
    clearInterval(videoArrowState.timer);
    videoArrowState.timer = 0;
  }
}
