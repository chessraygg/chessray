/**
 * Overlay renderer — transparent always-on-top window that draws arrows and debug panel.
 * Port of content/overlay.ts adapted for Electron (no Shadow DOM, screen coords).
 */

import type { ArrowDescriptor, PipelineResult } from '@chessray/core';
import { computeCurveOffsets, computePvArrows } from '@chessray/core';

declare global {
  interface Window {
    chessRay: {
      onFrameResult: (cb: (result: unknown) => void) => void;
      onStopTracking: (cb: () => void) => void;
      setMousePassthrough: (passthrough: boolean) => void;
      onDisplayInfo: (cb: (info: any) => void) => void;
      onSourceVisibility: (cb: (visible: boolean) => void) => void;
      reopenPicker: () => void;
      minimizeApp: () => void;
      closeApp: () => void;
    };
  }
}

let videoCanvas: HTMLCanvasElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let debugPanel: HTMLDivElement | null = null;
let debugImg: HTMLImageElement | null = null;
let debugFen: HTMLDivElement | null = null;
let debugInfo: HTMLDivElement | null = null;
let currentArrows: ArrowDescriptor[] = [];
let currentResult: PipelineResult | null = null;
let isTracking = false;
let displayFlipped = false;
let overlayVisible = true;
let borderVisible = false;
let arrowsVisible = true;
let lineVisible = false;
let pvDepth = 4;
let evalBarVisible = true;
let sourceVisible = true;
let displayInfo: { size: { width: number; height: number }; workArea: { x: number; y: number; width: number; height: number }; scaleFactor: number; overlayBounds?: { x: number; y: number; width: number; height: number } } | null = null;

// ── Preferences persistence ──
const PREFS_KEY = 'chessray-prefs';

interface Prefs {
  overlayVisible: boolean;
  borderVisible: boolean;
  arrowsVisible: boolean;
  lineVisible: boolean;
  pvDepth: number;
  evalBarVisible: boolean;
  collapsed: boolean;
  panelLeft: number | null;
  panelTop: number | null;
}

const DEFAULT_PREFS: Prefs = {
  overlayVisible: true,
  borderVisible: false,
  arrowsVisible: true,
  lineVisible: false,
  pvDepth: 4,
  evalBarVisible: true,
  collapsed: false,
  panelLeft: null,
  panelTop: null,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

function savePrefs(partial: Partial<Prefs>): void {
  try {
    const current = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...current, ...partial }));
  } catch { /* ignore */ }
}

const PIECE_UNICODE: Record<string, string> = {
  K: '\u2654', Q: '\u2655', R: '\u2656', B: '\u2657', N: '\u2658', P: '\u2659',
  k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F',
  '.': '\u00B7',
};

function setupDrag(handle: HTMLElement, panel: HTMLElement): void {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    // Don't drag when clicking buttons
    if ((e.target as HTMLElement).closest('button')) return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = `${startLeft + dx}px`;
    panel.style.top = `${startTop + dy}px`;
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      const rect = panel.getBoundingClientRect();
      savePrefs({ panelLeft: Math.round(rect.left), panelTop: Math.round(rect.top) });
    }
    isDragging = false;
  });
}

function initOverlay(): void {
  const prefs = loadPrefs();
  overlayVisible = prefs.overlayVisible;
  borderVisible = prefs.borderVisible;
  arrowsVisible = prefs.arrowsVisible;
  lineVisible = prefs.lineVisible;
  pvDepth = prefs.pvDepth;
  evalBarVisible = prefs.evalBarVisible;

  videoCanvas = document.getElementById('video-overlay') as HTMLCanvasElement;
  debugPanel = document.getElementById('debug-panel') as HTMLDivElement;
  debugImg = document.getElementById('cv-debug-img') as HTMLImageElement;
  debugFen = document.getElementById('cv-debug-fen') as HTMLDivElement;
  debugInfo = document.getElementById('cv-debug-info') as HTMLDivElement;
  canvas = document.getElementById('cv-arrow-canvas') as HTMLCanvasElement;

  // Interactive debug panel: disable click-through on hover
  if (debugPanel) {
    debugPanel.addEventListener('mouseenter', () => {
      window.chessRay.setMousePassthrough(false);
    });
    debugPanel.addEventListener('mouseleave', () => {
      window.chessRay.setMousePassthrough(true);
    });
  }

  // Make debug panel draggable by its header
  const header = document.querySelector('.panel-header') as HTMLElement | null;
  if (header && debugPanel) {
    setupDrag(header, debugPanel);
  }

  // Restore panel position
  if (debugPanel && prefs.panelLeft != null && prefs.panelTop != null) {
    debugPanel.style.left = `${prefs.panelLeft}px`;
    debugPanel.style.top = `${prefs.panelTop}px`;
    debugPanel.style.right = 'auto';
  }

  // Restore visual state from prefs
  if (videoCanvas) videoCanvas.style.display = overlayVisible ? '' : 'none';

  // Global overlay toggle
  const overlayBtn = document.getElementById('cv-overlay-btn');
  if (overlayBtn) {
    overlayBtn.classList.toggle('active', overlayVisible);
    overlayBtn.addEventListener('click', () => {
      overlayVisible = !overlayVisible;
      if (videoCanvas) videoCanvas.style.display = overlayVisible ? '' : 'none';
      overlayBtn.classList.toggle('active', overlayVisible);
      document.querySelectorAll('.vis-btn').forEach(btn => {
        (btn as HTMLButtonElement).disabled = !overlayVisible;
      });
      savePrefs({ overlayVisible });
    });
  }

  // Per-element visibility toggles
  const borderBtn = document.getElementById('cv-border-btn');
  if (borderBtn) {
    borderBtn.classList.toggle('active', borderVisible);
    borderBtn.addEventListener('click', () => {
      borderVisible = !borderVisible;
      borderBtn.classList.toggle('active', borderVisible);
      savePrefs({ borderVisible });
    });
  }

  const arrowsBtn = document.getElementById('cv-arrows-btn');
  const lineBtn = document.getElementById('cv-line-btn');
  const pvDepthRow = document.getElementById('cv-pv-depth-row');
  const pvDepthSlider = document.getElementById('cv-pv-depth') as HTMLInputElement | null;
  const pvDepthVal = document.getElementById('cv-pv-depth-val');

  if (arrowsBtn) {
    arrowsBtn.classList.toggle('active', arrowsVisible);
    arrowsBtn.addEventListener('click', () => {
      arrowsVisible = !arrowsVisible;
      arrowsBtn.classList.toggle('active', arrowsVisible);
      if (arrowsVisible && lineVisible) {
        lineVisible = false;
        lineBtn?.classList.toggle('active', false);
        if (pvDepthRow) pvDepthRow.style.display = 'none';
      }
      savePrefs({ arrowsVisible, lineVisible });
      renderArrows();
    });
  }

  if (lineBtn) {
    lineBtn.classList.toggle('active', lineVisible);
    if (pvDepthRow) pvDepthRow.style.display = lineVisible ? 'flex' : 'none';
    lineBtn.addEventListener('click', () => {
      lineVisible = !lineVisible;
      lineBtn.classList.toggle('active', lineVisible);
      if (pvDepthRow) pvDepthRow.style.display = lineVisible ? 'flex' : 'none';
      if (lineVisible && arrowsVisible) {
        arrowsVisible = false;
        arrowsBtn?.classList.toggle('active', false);
      }
      savePrefs({ arrowsVisible, lineVisible });
      renderArrows();
    });
  }

  if (pvDepthSlider && pvDepthVal) {
    pvDepthSlider.value = String(pvDepth);
    pvDepthVal.textContent = String(pvDepth);
    pvDepthSlider.addEventListener('input', () => {
      pvDepth = parseInt(pvDepthSlider.value, 10);
      pvDepthVal.textContent = String(pvDepth);
      savePrefs({ pvDepth });
      renderArrows();
    });
  }

  const evalBtn = document.getElementById('cv-eval-btn');
  if (evalBtn) {
    evalBtn.classList.toggle('active', evalBarVisible);
    evalBtn.addEventListener('click', () => {
      evalBarVisible = !evalBarVisible;
      evalBtn.classList.toggle('active', evalBarVisible);
      savePrefs({ evalBarVisible });
    });
  }

  // Collapse panel
  const collapseBtn = document.getElementById('cv-collapse-btn');
  const panelBody = document.getElementById('cv-panel-body');
  if (collapseBtn && debugPanel && panelBody) {
    let collapsed = prefs.collapsed;
    if (collapsed) {
      panelBody.classList.add('hidden');
      debugPanel.classList.add('collapsed');
      collapseBtn.classList.add('down');
    }
    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      panelBody.classList.toggle('hidden', collapsed);
      debugPanel!.classList.toggle('collapsed', collapsed);
      collapseBtn.classList.toggle('down', collapsed);
      savePrefs({ collapsed });
    });
  }

  // Window controls
  const minimizeBtn = document.getElementById('cv-minimize-btn');
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => {
      window.chessRay.minimizeApp();
    });
  }

  const closeBtn = document.getElementById('cv-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.chessRay.closeApp();
    });
  }
}

function setTrackingState(tracking: boolean): void {
  isTracking = tracking;
  const status = document.getElementById('cv-status');
  const content = document.getElementById('cv-tracking-content');
  if (status) {
    status.textContent = tracking ? 'Tracking active' : 'Waiting for source selection...';
    status.classList.toggle('tracking', tracking);
  }
  if (content) {
    content.classList.toggle('active', tracking);
  }
}

function updateDebugPanel(result: PipelineResult): void {
  if (!debugPanel) return;

  if (debugImg && result.board_image_url) {
    debugImg.src = result.board_image_url;
  }

  if (debugFen) {
    debugFen.textContent = result.recognition?.fen || 'No recognition';
  }

  // Update piece grid
  const grid = document.getElementById('cv-debug-grid');
  // highlighted_squares are in corrected (standard) orientation after recognizeBoard().
  // When flipped, the display grid is reversed — remap indices to display coords.
  const rawHl = result.highlighted_squares || [];
  const hl = new Set(result.flipped ? rawHl.map(i => 63 - i) : rawHl);
  if (grid && result.recognition?.fen) {
    let fenRows = result.recognition.fen.split('/');
    if (result.flipped) {
      fenRows = fenRows.reverse().map(r => r.split('').reverse().join(''));
    }

    let html = '';
    let rank = 0;
    for (const row of fenRows) {
      let file = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          for (let i = 0; i < parseInt(ch); i++) {
            const sq = (rank + file) % 2 === 0 ? 'light' : 'dark';
            const hi = hl.has(rank * 8 + file) ? ' highlight' : '';
            html += `<span class="${sq}${hi} empty">\u00B7</span>`;
            file++;
          }
        } else {
          const sq = (rank + file) % 2 === 0 ? 'light' : 'dark';
          const hi = hl.has(rank * 8 + file) ? ' highlight' : '';
          html += `<span class="${sq}${hi} piece">${PIECE_UNICODE[ch] || ch}</span>`;
          file++;
        }
      }
      rank++;
    }
    grid.innerHTML = html;
  }

  // Turn indicator
  const turnDot = document.getElementById('cv-turn-dot');
  const turnText = document.getElementById('cv-turn-text');
  if (turnDot && turnText && result.evaluation?.fen) {
    const fenParts = result.evaluation.fen.split(' ');
    const turn = fenParts[1] || 'w';
    turnDot.className = `turn-dot ${turn === 'w' ? 'white' : 'black'}`;
    turnText.textContent = turn === 'w' ? 'White to move' : 'Black to move';
  }
  const pawnDir = document.getElementById('cv-pawn-dir');
  if (pawnDir) {
    pawnDir.textContent = result.flipped ? '\u2193' : '\u2191';
  }
  const orientInfo = document.getElementById('cv-orientation-info');
  if (orientInfo) {
    const orientation = result.flipped ? 'white top' : 'white bottom';
    const sourceNames: Record<string, string> = {
      label: 'coord labels',
      pawn_move: 'pawn move',
      piece_count: 'piece positions',
    };
    const sourceLabel = sourceNames[result.orientation_source ?? ''] ?? '?';
    orientInfo.textContent = `${orientation} · ${sourceLabel}`;
  }

  // Eval bar
  const evalFill = document.getElementById('cv-eval-fill') as HTMLDivElement | null;
  const evalLabel = document.getElementById('cv-eval-label');
  if (evalFill && evalLabel && result.evaluation?.top_moves?.length) {
    const sideScore = result.evaluation.top_moves[0].score_cp;
    const turn = result.evaluation.fen?.split(' ')[1] || 'w';
    const bestScore = turn === 'b' ? -sideScore : sideScore;
    const winProb = 1 / (1 + Math.pow(10, -bestScore / 400));
    const fillPct = displayFlipped ? (1 - winProb) * 100 : winProb * 100;
    evalFill.style.width = `${fillPct.toFixed(1)}%`;
    evalFill.style.background = displayFlipped ? '#272727' : '#d4d4d4';
    evalFill.parentElement!.style.background = displayFlipped ? '#d4d4d4' : '#272727';

    if (Math.abs(bestScore) >= 9000) {
      const mateIn = bestScore > 0 ? 10000 - bestScore : -(10000 + bestScore);
      evalLabel.textContent = `M${Math.abs(mateIn)}`;
    } else {
      const scoreStr = bestScore >= 0 ? `+${(bestScore/100).toFixed(1)}` : (bestScore/100).toFixed(1);
      evalLabel.textContent = scoreStr;
    }
  }

  // Depth
  const depthLabel = document.getElementById('cv-eval-depth');
  if (depthLabel && result.eval_depth) {
    depthLabel.textContent = `d${result.eval_depth}`;
  }

  // Best moves
  const bestMoves = document.getElementById('cv-best-moves');
  if (bestMoves && result.evaluation?.top_moves?.length) {
    let html = '';
    for (const move of result.evaluation.top_moves) {
      const scoreStr = move.score_cp >= 0 ? `+${(move.score_cp/100).toFixed(1)}` : (move.score_cp/100).toFixed(1);
      const lossStr = move.loss_cp > 0 ? ` (\u2212${move.loss_cp}cp)` : '';
      html += `<div class="move-line"><span class="move-score">${scoreStr}</span>${move.pv.slice(0, 5).join(' ')}${lossStr}</div>`;
    }
    bestMoves.innerHTML = html;
  }

  if (debugInfo) {
    const parts: string[] = [];
    if (result.recognition) {
      parts.push(`conf: ${(result.recognition.confidence * 100).toFixed(0)}%`);
    }
    parts.push(`${result.total_elapsed_ms}ms`);
    debugInfo.textContent = parts.join(' | ');
  }
}

/** Get the arrows to display based on current mode (top moves vs PV line) */
function getActiveArrows(): ArrowDescriptor[] {
  if (lineVisible && currentResult?.evaluation?.top_moves?.length) {
    const pv = currentResult.evaluation.top_moves[0].pv;
    const turn = currentResult.evaluation.fen?.split(' ')[1] as 'w' | 'b' || 'w';
    return computePvArrows(pv, turn, pvDepth);
  }
  return currentArrows;
}

function renderArrows(): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const virtualBoard = { x: 0, y: 0, width: 192, height: 192 };
  const arrows = getActiveArrows();

  if (arrows.length === 0) return;

  const offsets = computeCurveOffsets(arrows);
  for (let i = arrows.length - 1; i >= 0; i--) {
    drawArrow(ctx, arrows[i], virtualBoard, 1, offsets[i]);
  }
}


function drawArrow(
  ctx: CanvasRenderingContext2D,
  arrow: ArrowDescriptor,
  board: { x: number; y: number; width: number; height: number },
  widthScale: number,
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
  ctx.globalAlpha = arrow.opacity;
  ctx.strokeStyle = arrow.color;
  ctx.fillStyle = arrow.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  // Draw the shaft (quadratic bezier curve)
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if (curveOffset === 0) {
    ctx.lineTo(tipBackX, tipBackY);
  } else {
    ctx.quadraticCurveTo(mx, my, tipBackX, tipBackY);
  }
  ctx.stroke();

  // Draw the arrowhead
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
    ctx.globalAlpha = Math.min(1, arrow.opacity + 0.2);
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

/** Draw arrows and eval bar on the full-screen overlay canvas */
function renderVideoOverlay(): void {
  if (!videoCanvas) return;
  const ctx = videoCanvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);

  if (!sourceVisible) return;

  const result = currentResult;
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

  if (videoCanvas.width !== vw || videoCanvas.height !== vh) {
    videoCanvas.width = vw;
    videoCanvas.height = vh;
    videoCanvas.style.width = vw + 'px';
    videoCanvas.style.height = vh + 'px';
  }

  // Frame is in physical pixels, overlay canvas is in CSS pixels.
  // Divide by devicePixelRatio to convert frame → CSS pixels.
  // The overlay window may be offset from the top of the screen (e.g. macOS
  // menu bar pushes it to y=25). Use the actual overlay bounds to compute the
  // offset between frame coordinates (screen-relative) and overlay coordinates.
  const dpr = displayInfo?.scaleFactor ?? window.devicePixelRatio;
  // overlayBounds.y is in screen points (from Electron getBounds), not physical pixels.
  const overlayYOffset = displayInfo?.overlayBounds?.y ?? 0;

  const bbox = result.board_detection.bbox;
  const bx = bbox.x / dpr;
  const by = bbox.y / dpr - overlayYOffset;
  const bw = bbox.width / dpr;
  const bh = bbox.height / dpr;

  const boardRect = { x: bx, y: by, width: bw, height: bh };

  if (borderVisible) {
    ctx.strokeStyle = 'rgba(255, 0, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
  }

  if (arrowsVisible || lineVisible) {
    const arrows = getActiveArrows();
    const arrowScale = (bw + bh) / 2 / 192;

    const offsets = computeCurveOffsets(arrows);
    for (let i = arrows.length - 1; i >= 0; i--) {
      drawArrow(ctx, arrows[i], boardRect, arrowScale, offsets[i]);
    }
  }

  // Eval bar
  if (evalBarVisible && result.evaluation?.top_moves?.length) {
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

    if (displayFlipped) {
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

function clearVideoOverlay(): void {
  if (!videoCanvas) return;
  const ctx = videoCanvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
}

// ── Init ──

initOverlay();

// Listen for frame results via IPC
let pendingResult: PipelineResult | null = null;
let rafScheduled = false;

function processPendingResult(): void {
  rafScheduled = false;
  const result = pendingResult;
  if (!result) return;
  pendingResult = null;

  if (!isTracking) setTrackingState(true);
  displayFlipped = !!result.flipped;
  currentResult = result;

  updateDebugPanel(result);
  currentArrows = result.arrows?.length > 0 ? result.arrows : [];
  renderArrows();
  renderVideoOverlay();
}

window.chessRay.onFrameResult((result) => {
  pendingResult = result as PipelineResult;
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(processPendingResult);
  }
});

window.chessRay.onDisplayInfo((info) => {
  displayInfo = info;
});

window.chessRay.onSourceVisibility((visible) => {
  sourceVisible = visible;
  if (!visible) {
    clearVideoOverlay();
  } else if (currentResult) {
    renderVideoOverlay();
  }
});

window.chessRay.onStopTracking(() => {
  setTrackingState(false);
  currentArrows = [];
  currentResult = null;
  renderArrows();
  clearVideoOverlay();
});
