import type { ArrowDescriptor, GameOver, PipelineResult } from '@chessray/core';
import type { Turn } from '@chessray/core';
import { computeCurveOffsets, lossToColor, rgbToCss, squareColorPalette, type RGB } from '@chessray/core';
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
  /** User-configurable decoration knobs — apply to arrows, PV step labels,
   *  and played-move markers. `overlaySize` is the best-move arrow width at
   *  the canonical 192px board (other ranks/marker radii scale proportionally
   *  against the 5px baseline). `overlayOpacity` is the uniform alpha. */
  overlaySize: number;
  overlayOpacity: number;
  /** Minimum alpha for the actual-board eval bar when the eval is stale. */
  evalBarStaleOpacity: number;
  /** User-supplied orientation override (null = auto). Display-only in the
   *  renderer — the pipeline enforces it via IPC; here it's used for UI state. */
  manualOrientationFlip: boolean | null;
  panelScale: number;
  boardScale: number;
  displayInfo: {
    size?: { width: number; height: number };
    workArea?: { x: number; y: number; width: number; height: number };
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

/** Game-over watermark — thin, wide-tracked text centered on the board over
 *  the dim overlay. No pill or chrome; the dim does the "game is over" work
 *  and the watermark names the outcome subtly. Alpha is capped by the user's
 *  overlayOpacity so the whole annotation family scales together. */
function drawGameOverPill(
  ctx: CanvasRenderingContext2D,
  board: { x: number; y: number; width: number; height: number },
  gameOver: GameOver,
  turn: Turn | undefined,
  overlayOpacity: number,
): void {
  const raw = gameOver === 'checkmate'
    ? (turn === 'w' ? 'Black wins' : 'White wins')
    : 'Draw';
  const text = raw.toUpperCase();

  const size = Math.min(board.width, board.height);
  // Target ~58% of board width; font starts at ~11% of board and shrinks if
  // the text would overflow (e.g. extremely wide letter-spacing on narrow boards).
  let fontSize = Math.round(size * 0.11);
  const letterSpacing = Math.max(2, Math.round(fontSize * 0.18));
  ctx.font = `300 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const targetW = board.width * 0.58;
  const measure = (): number => {
    // Canvas doesn't expose letter-spacing width directly — approximate by
    // summing per-char widths plus the spacing gaps.
    let w = 0;
    for (let i = 0; i < text.length; i++) {
      w += ctx.measureText(text[i]).width;
    }
    return w + letterSpacing * Math.max(0, text.length - 1);
  };
  let currentW = measure();
  if (currentW > targetW) {
    fontSize = Math.max(14, Math.round(fontSize * targetW / currentW));
    ctx.font = `300 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    currentW = measure();
  }

  const cx = board.x + board.width / 2;
  const cy = board.y + board.height / 2;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, overlayOpacity * 0.65));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  // Draw char-by-char so we can apply letter-spacing in a cross-browser way.
  let x = cx - currentW / 2;
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i], x, cy);
    x += ctx.measureText(text[i]).width + letterSpacing;
  }
  ctx.restore();
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
  /** User-pref scales: `sizeScale` multiplies the marker radius/font,
   *  `opacityScale` multiplies the uniform alpha (stacks with opacityMul). */
  sizeScale: number = 1,
  opacityScale: number = 1,
): void {
  const squareW = board.width / 8;
  const squareH = board.height / 8;
  let file = square.charCodeAt(0) - 97;
  let rank = parseInt(square[1], 10) - 1;
  if (displayFlipped) { file = 7 - file; rank = 7 - rank; }

  const cx = board.x + (file + 0.5) * squareW;
  const cy = board.y + (7 - rank + 0.5) * squareH;
  // Disc alpha scales with BOTH the pulse (opacityMul) and the user's overlay
  // opacity (opacityScale) — disc is decoration. The glyph (checkmark /
  // loss text) scales only with the pulse, staying fully visible even when
  // the user dials overlay opacity down.
  const discAlpha = opacityMul * opacityScale;
  const glyphAlpha = opacityMul;

  if (lossCp < 10) {
    // Excellent move — white checkmark inside a solid-enough green disc.
    const r = Math.min(squareW, squareH) * 0.22 * sizeScale;
    const size = r * 1.25;
    const strokeW = Math.max(2, r * 0.28);

    ctx.save();
    ctx.globalAlpha = 0.85 * discAlpha;
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = glyphAlpha;
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

  // Loss badge — colored disc with centipawn loss text inside.
  const fontSize = Math.max(7, Math.round(Math.min(squareW, squareH) * 0.20 * sizeScale));
  const r = fontSize * 1.25;
  const color = lossToColor(lossCp);

  ctx.save();
  ctx.globalAlpha = 0.9 * discAlpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // White text at full glyph alpha with a heavy black outline so the number
  // stays readable over any loss color (including amber/yellow).
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Disc color already encodes "this is a cp loss" — no minus sign needed.
  const text = (lossCp / 100).toFixed(1);
  ctx.globalAlpha = glyphAlpha;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2.5, fontSize * 0.22);
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
  // Head is a triangle whose base exactly matches the ribbon tip width (so
  // there's no perpendicular gap at the join) and whose length along the
  // shaft is 2× the tip width (classic 2:1 pointy arrowhead). Everything
  // scales with the current tip width, so during fade-in the head stays
  // proportional and endX,endY can't land behind the source.
  const headShaft = wTip * 2;   // head length along shaft (endX→tip)
  const headBase = wTip;        // head base width at endX (= ribbon tip width)

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

  // Ribbon ends exactly at the head's base plane (no along-shaft sliver).
  const endX = noArrowhead ? x2 : x2 - headShaft * Math.cos(tipAngle);
  const endY = noArrowhead ? y2 : y2 - headShaft * Math.sin(tipAngle);

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

  // Arrowhead — triangle from (x2,y2) back to base vertices placed exactly at
  // the ribbon's end plane (endX,endY) offset perpendicular by the ribbon's
  // tip half-width. Base width = wTip so ribbon and head meet flush.
  if (!noArrowhead) {
    const halfBase = headBase / 2;
    const perpX = -Math.sin(tipAngle);
    const perpY = Math.cos(tipAngle);
    ctx.globalAlpha = arrow.opacity;
    ctx.fillStyle = arrow.color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(endX + perpX * halfBase, endY + perpY * halfBase);
    ctx.lineTo(endX - perpX * halfBase, endY - perpY * halfBase);
    ctx.closePath();
    ctx.fill();
  }

  // Step-number label — a dark pill with a colored identity ring, drawn at
  // the top-right corner of the destination square so it tags the arriving
  // piece instead of sitting on top of the shaft. Stays fully opaque
  // regardless of arrow alpha so it's legible under any fade/dim state.
  if (arrow.label && t >= 1) {
    const fontSize = Math.max(9, lineWidth * 2);
    const r = fontSize * 0.85;
    const strokeW = Math.max(1.5, fontSize * 0.14);
    // Offset from destination center toward the top-right corner, clamped so
    // the pill stays inside the square on smaller boards (e.g. vboard mini).
    const margin = 2;
    const offX = Math.min(squareW * 0.30, Math.max(0, squareW / 2 - r - margin));
    const offY = Math.min(squareH * 0.30, Math.max(0, squareH / 2 - r - margin));
    const ox = x2 + offX;
    const oy = y2 - offY;

    // Solid near-black pill (independent of arrow.opacity).
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#0f0f0f';
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fill();

    // Colored ring ties the pill to the arrow's line.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = arrow.color;
    ctx.lineWidth = strokeW;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Bold white number.
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
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

  // Game over — dim the whole board, then fade in a subtle watermark naming
  // the outcome. Dim does the "game ended" work, watermark names the result.
  if (state.currentResult?.game_over) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, size, size);
    drawGameOverPill(ctx, virtualBoard, state.currentResult.game_over, state.currentResult.turn, state.overlayOpacity);
    return;
  }

  // Mark the played move's target square (on the moved piece) with a loss-colored dot
  const userSizeScale = state.overlaySize / 5;
  // Skip the quality marker while loss is still unknown (eval pending) —
  // rendering anything would either misleadingly claim "excellent" or paint
  // a fake colored disc.
  const pmVboard = state.currentResult?.played_move;
  if (pmVboard && pmVboard.loss_cp !== null) {
    drawPlayedMoveMarker(ctx, pmVboard.to, pmVboard.loss_cp, virtualBoard, state.displayFlipped, 1, userSizeScale, state.overlayOpacity);
  }

  const targetArrows = getActiveArrows(state);
  const isPreview = state.pvPreviewLineIndex !== null;

  if (targetArrows.length === 0 && !state.currentResult?.played_move && !isPreview) {
    // Nothing to draw, but keep `.animated` intact so arrows that return later
    // (e.g. after playback, loss-threshold change, visibility toggle) are
    // matched by from-to and stay steady instead of re-growing from source.
    if (vboardArrowState.timer) { clearInterval(vboardArrowState.timer); vboardArrowState.timer = 0; }
    vboardHitCache.arrows = [];
    vboardHitCache.animBoardRect = null;
    return;
  }

  // Apply user opacity pref to the fade-in target so animated.fadeOpacity ramps
  // toward the user's max, and keep user size pref as a widthScale multiplier.
  const scaledTargets = targetArrows.map(a => ({ ...a, opacity: state.overlayOpacity }));
  const animated = updateAnimatedArrows(scaledTargets, vboardArrowState, () => renderArrows(state));
  const drawList = animated.map(a => ({ arrow: { ...a, opacity: a.fadeOpacity }, progress: a.progress }));

  const offsets = computeCurveOffsets(drawList.map(d => d.arrow));
  vboardHitCache.arrows = [];
  vboardHitCache.animBoardRect = null;
  const hoveredIdx = state.hoveredArrowIndex;
  const userWidthMult = state.overlaySize / 5;
  for (let i = drawList.length - 1; i >= 0; i--) {
    const isLineArrow = !!drawList[i].arrow.label;
    const arrow = drawList[i].arrow;
    const lineIdx = state.currentArrows.findIndex(a => a.from === arrow.from && a.to === arrow.to);
    let effectiveOpacity = arrow.opacity;
    if (hoveredIdx !== null && lineIdx >= 0) {
      if (lineIdx === hoveredIdx) effectiveOpacity = 1.0;
      else effectiveOpacity = arrow.opacity * 0.25;
    }
    drawArrow(ctx, { ...arrow, opacity: effectiveOpacity }, virtualBoard, userWidthMult, state.displayFlipped, offsets[i], drawList[i].progress, isLineArrow);
    if (lineIdx >= 0 && drawList[i].progress >= 1) {
      vboardHitCache.arrows.push(computeArrowHitShape(arrow, virtualBoard, userWidthMult, state.displayFlipped, offsets[i], lineIdx));
    }
  }

  // Preview emphasis — render the highlighted line's arrow at full opacity
  // over the normal arrows. No pulsing; just a steady, clearly-emphasized
  // preview. Loss marker draws on the destination at the same steady alpha.
  if (isPreview) {
    const previewArrow = getPreviewArrow(state);
    if (previewArrow && state.currentResult?.evaluation?.top_moves?.length) {
      drawArrow(
        ctx,
        previewArrow,
        virtualBoard, userWidthMult, state.displayFlipped,
        0, 1, false, false,
      );
      const moves = state.currentResult.evaluation.top_moves;
      const idx = Math.min(state.pvPreviewLineIndex!, moves.length - 1);
      const move = moves[idx];
      const to = move.move.slice(2, 4);
      drawPlayedMoveMarker(ctx, to, move.loss_cp, virtualBoard, state.displayFlipped, 1, userSizeScale, state.overlayOpacity);
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
  // actually read. Exception: if the position is game-over (checkmate /
  // stalemate), keep rendering the dim + corner pill so it doesn't flicker
  // off on low-confidence frames — the game has ended, the board isn't
  // changing. Canvas was cleared above, so returning here hides the overlay.
  const recogConfidence = result.recognition?.confidence ?? 0;
  if (recogConfidence < 0.3 && !result.game_over) {
    videoHitCache.arrows = [];
    videoHitCache.animBoardRect = null;
    if (videoArrowState.timer) { clearInterval(videoArrowState.timer); videoArrowState.timer = 0; }
    logEvalBarTransition('video', false, `low confidence: ${(recogConfidence * 100).toFixed(0)}%`);
    return;
  }

  // The overlay window covers the work area (excludes menu bar/dock).
  // The captured frame covers the full display (includes menu bar).
  // We need to map frame pixels → overlay CSS pixels, accounting for:
  // 1. devicePixelRatio (frame is in physical pixels, overlay is in CSS pixels)
  // 2. Menu bar offset (frame y=0 is top of screen, overlay y=0 is top of work area)
  //
  // For the extension on a content-script page we want the same viewport
  // units the capture is pinned to. Capture (offscreen.ts + SW) pins
  // min=max to innerWidth/Height × DPR (the render-widget surface,
  // includes scrollbar gutter). Using clientWidth/visualViewport here
  // would underestimate by the scrollbar width and slightly compress
  // the bbox horizontally. innerWidth keeps the units consistent end-
  // to-end so frame ÷ DPR ≈ vw exactly.
  const docEl = document.documentElement;
  const vw = window.innerWidth || docEl?.clientWidth || 0;
  const vh = window.innerHeight || docEl?.clientHeight || 0;

  if (state.videoCanvas.width !== vw || state.videoCanvas.height !== vh) {
    state.videoCanvas.width = vw;
    state.videoCanvas.height = vh;
    state.videoCanvas.style.width = vw + 'px';
    state.videoCanvas.style.height = vh + 'px';
  }

  // Two coordinate systems converge here:
  //   - Electron host: bbox is in the captured display's *physical* pixels,
  //     overlay canvas covers the work area in CSS pixels offset by the
  //     menu bar — divide by scaleFactor and subtract overlayYOffset.
  //   - Extension host: bbox is in the captured tab's frame pixels,
  //     overlay canvas covers the visible viewport — scale by
  //     viewport/frame so it's correct regardless of DPR, browser
  //     chrome, or side-panel resize that changed the document width.
  const bbox = result.board_detection.bbox;
  let bx: number, by: number, bw: number, bh: number;
  if (state.displayInfo) {
    const dpr = state.displayInfo.scaleFactor;
    const overlayY = state.displayInfo.overlayBounds?.y ?? 0;
    const displayY = state.displayInfo.displayBounds?.y ?? 0;
    const overlayYOffset = overlayY - displayY;
    bx = bbox.x / dpr;
    by = bbox.y / dpr - overlayYOffset;
    bw = bbox.width / dpr;
    bh = bbox.height / dpr;
  } else if (result.frame_dimensions) {
    const fw = result.frame_dimensions.width;
    const fh = result.frame_dimensions.height;
    // Independent x/y scale assumes the captured frame *is* the viewport,
    // just at a different resolution. That's true when capture pinned
    // min=max to viewport×DPR (extension's normal path). When constraints
    // didn't take — Chrome falls back to a default cap and letterboxes —
    // the frame is centered inside the captured surface with black bars,
    // and a per-axis scale would distort. Detect by aspect-ratio mismatch
    // (>1% off): center-crop to the viewport AR, then scale uniformly.
    const viewportAR = vw / Math.max(1, vh);
    const frameAR = fw / Math.max(1, fh);
    let activeX = 0, activeY = 0, activeW = fw, activeH = fh;
    if (Math.abs(frameAR - viewportAR) / viewportAR > 0.01) {
      if (frameAR > viewportAR) {
        activeW = fh * viewportAR;
        activeX = (fw - activeW) / 2;
      } else {
        activeH = fw / viewportAR;
        activeY = (fh - activeH) / 2;
      }
    }
    const sx = vw / Math.max(1, activeW);
    const sy = vh / Math.max(1, activeH);
    bx = (bbox.x - activeX) * sx;
    by = (bbox.y - activeY) * sy;
    bw = bbox.width * sx;
    bh = bbox.height * sy;
  } else {
    // Last-resort fallback: assume frame already in CSS pixels.
    bx = bbox.x;
    by = bbox.y;
    bw = bbox.width;
    bh = bbox.height;
  }

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
    const userSizeScaleVideo = state.overlaySize / 5;
    const pmVideo = result.played_move;
    if (pmVideo && pmVideo.loss_cp !== null) {
      drawPlayedMoveMarker(ctx, pmVideo.to, pmVideo.loss_cp, boardRect, state.displayFlipped, 1, userSizeScaleVideo, state.overlayOpacity);
    }

    if (state.arrowsVisible || state.pvPreviewLineIndex !== null) {
      const targetArrows = getActiveArrows(state);
      // Apply user opacity pref as the fade-in target.
      const scaledTargets = targetArrows.map(a => ({ ...a, opacity: state.overlayOpacity }));
      const animated = updateAnimatedArrows(scaledTargets, videoArrowState, () => renderVideoOverlay(state));
      const drawList = animated.map(a => ({ arrow: { ...a, opacity: a.fadeOpacity }, progress: a.progress }));
      const userWidthMult = state.overlaySize / 5;
      const arrowScale = (bw + bh) / 2 / 192 * userWidthMult;
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

      // Preview emphasis — render the highlighted line's arrow at full
      // opacity (no pulse, no bell gradient). Steady and clear.
        if (isPreview) {
        const previewArrow = getPreviewArrow(state);
        if (previewArrow && result.evaluation?.top_moves?.length) {
          drawArrow(
            ctx,
            previewArrow,
            boardRect, arrowScale, state.displayFlipped,
            0, 1, false, false,
          );
          const idx = Math.min(state.pvPreviewLineIndex!, result.evaluation.top_moves.length - 1);
          const move = result.evaluation.top_moves[idx];
          const to = move.move.slice(2, 4);
          drawPlayedMoveMarker(ctx, to, move.loss_cp, boardRect, state.displayFlipped, 1, userSizeScaleVideo, state.overlayOpacity);
        }
      }
    } else {
      // Arrows hidden (e.g. during the brief gap between PV steps, or while
      // arrowsVisible=false with no preview). Pause the fade timer but keep
      // `.animated` so the same arrows resume steady when they reappear.
      if (videoArrowState.timer) { clearInterval(videoArrowState.timer); videoArrowState.timer = 0; }
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
    if (isStale) ctx.globalAlpha = state.evalBarStaleOpacity;

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

  // Game over on actual board — dim + subtle centered watermark.
  if (result.game_over) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(bx, by, bw, bh);
    drawGameOverPill(ctx, { x: bx, y: by, width: bw, height: bh }, result.game_over, result.turn, state.overlayOpacity);
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
