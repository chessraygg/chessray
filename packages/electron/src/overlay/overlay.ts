/**
 * Overlay renderer — transparent always-on-top window that draws arrows and debug panel.
 * Port of content/overlay.ts adapted for Electron (no Shadow DOM, screen coords).
 */

import type { PipelineResult } from '../shared/types.js';
import { applyUciMoves, uciToSan, fenSimilarity } from '@chessray/core';
import { lossToColor } from '../shared/arrows.js';
import { loadPrefs, savePrefs } from './preferences.js';
import { type OverlayState, renderArrows, renderVideoOverlay, clearVideoOverlay, resetVideoArrowAnimation, drawArrow, videoHitCache, vboardHitCache, hitTestArrows, hitTestAnimBoard } from './canvas-renderer.js';
import { preloadPieceImages } from './piece-svg.js';
import { setupDrag, updateDebugPanel, clearDebugPanel, renderBoardGrid, setFpsBudgetMs, setActiveFpsDisplay, renderDebugHistoryNav, formatDebugReport, type DebugHistoryNavState } from './debug-panel.js';
import { loadHistory, pushSlowFrame, clearHistory, snapshotToResult, type DebugSnapshot } from './debug-history.js';
import { pieceSvg } from './piece-svg.js';

/// <reference path="../shared/window.d.ts" />

// ── Module-level state ──
let lichessOpen = false;
let lichessSync = true;
let lastLichessFen: string | null = null;
let showMovesDelaySec = 0;
let movesHeld = false;
let movesHeldTimer: ReturnType<typeof setTimeout> | null = null;

let userPanel: HTMLDivElement | null = null;
let debugImg: HTMLImageElement | null = null;
let debugFen: HTMLDivElement | null = null;
let debugInfo: HTMLDivElement | null = null;
const useSan = true;

const state: OverlayState = {
  videoCanvas: null,
  canvas: null,
  currentResult: null,
  currentArrows: [],
  displayFlipped: false,
  overlayVisible: true,
  borderVisible: false,
  arrowsVisible: true,
  lineVisible: false,
  pvDepth: 10,
  pvDisplayDepth: 2,
  evalBarVisible: true,
  sourceVisible: true,
  selectedLineIndex: 0,
  lossThreshold: 50,
  vboardOverlayVisible: true,
  pvPreviewLineIndex: null,
  pvBoardState: null,
  hoveredArrowIndex: null,
  overlaySize: 5,
  overlayOpacity: 0.85,
  evalBarStaleOpacity: 0.75,
  manualOrientationFlip: null,
  panelScale: 1,
  boardScale: 1,
  displayInfo: null,
};

// ── Slow-frame history + FPS auto-tune state (declared before initOverlay so
//    the FPS slider setup inside initOverlay can call setActiveFps /
//    updateFpsBudget without hitting TDZ on the `let` bindings) ──
let debugHistory: DebugSnapshot[] = loadHistory();
/** null = viewing live; otherwise an index into debugHistory. */
let historyIndex: number | null = null;
/** Latest known FPS budget (ms = 1000 / activeFps). Recomputed whenever the
 *  controller changes activeFps; used to flag slow frames. */
let fpsBudgetMs = 500;
/** User-configured FPS bounds (mutated by the min/max sliders). */
const fpsRange = { min: 1, max: 5 };
/** Current FPS the controller is targeting. Lives in [fpsRange.min, fpsRange.max]. */
let activeFps = 2;
/** Controller state: count of consecutive fresh-and-comfortably-under-budget
 *  frames. When it hits the streak threshold the controller steps UP. */
let freshOnBudgetStreak = 0;
/** Frames remaining after a DOWN step before we'll consider stepping UP again
 *  (prevents oscillation if a slow frame was a transient stall). */
let slowGracePeriod = 0;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function updateFpsBudget(fps: number): void {
  fpsBudgetMs = 1000 / Math.max(1, fps);
  setFpsBudgetMs(fpsBudgetMs);
}

function setActiveFps(fps: number): void {
  const next = clamp(fps, fpsRange.min, fpsRange.max);
  if (next === activeFps) return;
  activeFps = next;
  freshOnBudgetStreak = 0;
  updateFpsBudget(activeFps);
  setActiveFpsDisplay(activeFps);
  window.chessRay.setTargetFps(activeFps);
  savePrefs({ targetFps: activeFps });
}

/** Per-frame AIMD controller. Called from onFrameResult.
 *  - Any slow frame (cached or fresh) → step DOWN.
 *  - Cached frame under budget → no signal (cache doesn't prove capacity).
 *  - Fresh frame under 60% budget → grow streak; UP after 3 in a row.
 *  - Fresh frame between 60% and 100% budget → hold (thin headroom). */
function tickFpsController(r: PipelineResult): void {
  const ft = r.frame_timing;
  if (!ft) return;
  const total = ft.capture_ms + ft.pipeline_ms + (ft.ipc_ms ?? 0) + (ft.render_ms ?? 0);

  if (total > fpsBudgetMs) {
    if (activeFps > fpsRange.min) setActiveFps(activeFps - 1);
    freshOnBudgetStreak = 0;
    slowGracePeriod = 3;
    return;
  }
  if (ft.recog_cached) return;
  if (slowGracePeriod > 0) { slowGracePeriod--; return; }
  if (total < fpsBudgetMs * 0.6) {
    freshOnBudgetStreak++;
    if (freshOnBudgetStreak >= 3 && activeFps < fpsRange.max) {
      setActiveFps(activeFps + 1);
    }
  } else {
    // Fresh frame, under budget but using > 60% — too thin to risk stepping up.
    freshOnBudgetStreak = 0;
  }
}

function frameTotalMs(r: PipelineResult): number {
  const ft = r.frame_timing;
  if (!ft) return r.total_elapsed_ms;
  return ft.capture_ms + ft.pipeline_ms + (ft.ipc_ms ?? 0) + (ft.render_ms ?? 0);
}

function ageLabel(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function refreshHistoryNav(navEl: HTMLElement | null): void {
  if (!navEl) return;
  const idx = historyIndex;
  const entry = idx !== null ? debugHistory[idx] : null;
  const navState: DebugHistoryNavState = {
    count: debugHistory.length,
    index: idx,
    ageLabel: entry ? ageLabel(entry.captured_at) : undefined,
    totalMs: entry?.total_ms,
  };
  renderDebugHistoryNav(navEl, navState, {
    prev: () => {
      if (debugHistory.length === 0) return;
      historyIndex = historyIndex === null
        ? debugHistory.length - 1
        : Math.max(0, historyIndex - 1);
      rerenderForHistoryChange();
    },
    next: () => {
      if (debugHistory.length === 0) return;
      if (historyIndex === null) return;
      if (historyIndex >= debugHistory.length - 1) {
        historyIndex = null; // past the end → return to live
      } else {
        historyIndex++;
      }
      rerenderForHistoryChange();
    },
    live: () => {
      historyIndex = null;
      rerenderForHistoryChange();
    },
    clear: () => {
      clearHistory();
      debugHistory = [];
      historyIndex = null;
      rerenderForHistoryChange();
    },
  });
}

function rerenderForHistoryChange(): void {
  const navEl = document.getElementById('cv-debug-history-nav');
  refreshHistoryNav(navEl);
  if (!state.currentResult) return;
  const snap = historyIndex !== null ? snapshotToResult(debugHistory[historyIndex]) : null;
  updateDebugPanel(state.currentResult, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, state.lossThreshold, selectLine, snap);
}

// ── Tooltip controller ──
// Renders `[data-tip]` text in a single shared element appended to <body>, so
// tooltips escape every ancestor overflow-clipping in the panel layout.
// Respects `data-tip-pos` (above / below / left / right) for alignment.
function initTooltips(): void {
  const tip = document.createElement('div');
  tip.className = 'cv-tooltip';
  document.body.appendChild(tip);

  let current: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const positionTip = (el: HTMLElement): void => {
    const rect = el.getBoundingClientRect();
    const pos = el.getAttribute('data-tip-pos') || 'above';
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Render invisibly first to measure.
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;

    let x: number, y: number;
    if (pos === 'below') {
      x = rect.left + rect.width / 2 - tw / 2;
      y = rect.bottom + margin;
    } else if (pos === 'left') {
      x = rect.left - tw - margin;
      y = rect.top + rect.height / 2 - th / 2;
    } else if (pos === 'right') {
      x = rect.right + margin;
      y = rect.top + rect.height / 2 - th / 2;
    } else {
      // above (default)
      x = rect.left + rect.width / 2 - tw / 2;
      y = rect.top - th - margin;
    }

    // Clamp inside the viewport so long tooltips don't fall off the edge.
    x = Math.max(4, Math.min(vw - tw - 4, x));
    y = Math.max(4, Math.min(vh - th - 4, y));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  const show = (el: HTMLElement): void => {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    positionTip(el);
    tip.classList.add('visible');
  };

  const hide = (): void => {
    tip.classList.remove('visible');
  };

  document.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement | null)?.closest('[data-tip]') as HTMLElement | null;
    if (!target || target === current) return;
    current = target;
    if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = setTimeout(() => { showTimer = null; show(target); }, 300);
  });
  document.addEventListener('mouseout', (e) => {
    const leaving = (e.target as HTMLElement | null)?.closest('[data-tip]') as HTMLElement | null;
    if (leaving !== current) return;
    if (showTimer !== null) { clearTimeout(showTimer); showTimer = null; }
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = null; hide(); current = null; }, 80);
  });
  // If the layout scrolls/reflows while a tip is visible, reposition against the current target.
  window.addEventListener('scroll', () => { if (current) positionTip(current); }, true);
  window.addEventListener('resize', () => { if (current) positionTip(current); });
}

// ── Init ──

function initOverlay(): void {
  preloadPieceImages();
  initTooltips();

  const prefs = loadPrefs();
  state.overlayVisible = prefs.overlayVisible;
  state.borderVisible = prefs.borderVisible;
  state.arrowsVisible = true;
  state.lineVisible = false;
  state.pvDepth = prefs.pvDepth;
  state.evalBarVisible = prefs.evalBarVisible;
  state.overlaySize = prefs.overlaySize;
  state.overlayOpacity = prefs.overlayOpacity;
  state.evalBarStaleOpacity = prefs.evalBarStaleOpacity;
  state.manualOrientationFlip = prefs.manualOrientationFlip;
  // Push the stored override to the analysis pipeline on startup so the
  // first frame renders at the right orientation.
  window.chessRay.setManualFlip(state.manualOrientationFlip);

  state.videoCanvas = document.getElementById('video-overlay') as HTMLCanvasElement;
  userPanel = document.getElementById('user-panel') as HTMLDivElement;
  debugImg = document.getElementById('cv-debug-img') as HTMLImageElement;
  debugFen = document.getElementById('cv-debug-fen') as HTMLDivElement;
  debugInfo = document.getElementById('cv-debug-info') as HTMLDivElement;
  state.canvas = document.getElementById('cv-arrow-canvas') as HTMLCanvasElement;

  // Arrow canvas size is set in renderArrows() with DPR scaling
  if (state.canvas) {
    state.canvas.style.width = '200px';
    state.canvas.style.height = '200px';
  }

  // Interactive panel: disable click-through on hover
  if (userPanel) {
    userPanel.addEventListener('mouseenter', () => {
      window.chessRay.setMousePassthrough(false);
    });
    userPanel.addEventListener('mouseleave', () => {
      window.chessRay.setMousePassthrough(true);
    });
  }

  // Interactive arrows on the actual-board overlay canvas.
  // The canvas must accept pointer events for hit-testing to work; window-level
  // click-through is still managed by setMousePassthrough and only disabled
  // while the mouse is actually over a hot region (arrow or animated board).
  if (state.videoCanvas) {
    state.videoCanvas.style.pointerEvents = 'auto';
    let videoHotRegion = false;
    const clearHotRegion = (): void => {
      if (videoHotRegion) {
        videoHotRegion = false;
        window.chessRay.setMousePassthrough(true);
      }
      if (state.hoveredArrowIndex !== null) {
        state.hoveredArrowIndex = null;
        renderVideoOverlay(state);
        renderArrows(state);
      }
      if (state.videoCanvas) state.videoCanvas.style.cursor = '';
    };
    state.videoCanvas.addEventListener('mousemove', (e) => {
      const px = e.clientX;
      const py = e.clientY;
      const overAnimBoard = state.pvBoardState !== null && hitTestAnimBoard(videoHitCache, px, py);
      const hoveredArrow = state.pvBoardState === null ? hitTestArrows(videoHitCache, px, py) : null;
      const inHotRegion = overAnimBoard || hoveredArrow !== null;
      if (inHotRegion && !videoHotRegion) {
        videoHotRegion = true;
        window.chessRay.setMousePassthrough(false);
      } else if (!inHotRegion && videoHotRegion) {
        videoHotRegion = false;
        window.chessRay.setMousePassthrough(true);
      }
      if (state.videoCanvas) {
        state.videoCanvas.style.cursor = inHotRegion ? 'pointer' : '';
      }
      if (hoveredArrow !== state.hoveredArrowIndex) {
        state.hoveredArrowIndex = hoveredArrow;
        renderVideoOverlay(state);
        renderArrows(state);
      }
    });
    state.videoCanvas.addEventListener('mouseleave', clearHotRegion);
    state.videoCanvas.addEventListener('click', (e) => {
      const px = e.clientX;
      const py = e.clientY;
      if (state.pvBoardState !== null) {
        if (hitTestAnimBoard(videoHitCache, px, py)) stopPvLine();
        return;
      }
      const hovered = hitTestArrows(videoHitCache, px, py);
      if (hovered !== null) triggerLine(hovered);
    });
  }

  // Interactive arrows on the virtual board canvas (inside the panel).
  // Passthrough is already handled by the panel's hover listeners, so we only
  // need hit-testing + cursor feedback + click dispatch.
  if (state.canvas) {
    const vboard = state.canvas;
    const clientToCanvas = (e: MouseEvent): { x: number; y: number } => {
      const rect = vboard.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * 200 / rect.width,
        y: (e.clientY - rect.top) * 200 / rect.height,
      };
    };
    vboard.addEventListener('mousemove', (e) => {
      const { x, y } = clientToCanvas(e);
      const playing = (window as any).__chessrayPvPlaying;
      const overAnimBoard = playing && hitTestAnimBoard(vboardHitCache, x, y);
      const hoveredArrow = !playing ? hitTestArrows(vboardHitCache, x, y) : null;
      vboard.style.cursor = (overAnimBoard || hoveredArrow !== null) ? 'pointer' : '';
      if (hoveredArrow !== state.hoveredArrowIndex) {
        state.hoveredArrowIndex = hoveredArrow;
        renderVideoOverlay(state);
        renderArrows(state);
      }
    });
    vboard.addEventListener('mouseleave', () => {
      vboard.style.cursor = '';
      if (state.hoveredArrowIndex !== null) {
        state.hoveredArrowIndex = null;
        renderVideoOverlay(state);
        renderArrows(state);
      }
    });
    vboard.addEventListener('click', (e) => {
      const { x, y } = clientToCanvas(e);
      if ((window as any).__chessrayPvPlaying) {
        if (hitTestAnimBoard(vboardHitCache, x, y)) stopPvLine();
        return;
      }
      const hovered = hitTestArrows(vboardHitCache, x, y);
      if (hovered !== null) triggerLine(hovered);
    });
  }

  // Panel is draggable on any background (setupDrag skips buttons, inputs, and anything
  // inside the split layout — section headers and splitters handle their own drags).
  if (userPanel) setupDrag(userPanel, userPanel);

  // Restore panel position
  if (userPanel && prefs.panelLeft != null && prefs.panelTop != null) {
    userPanel.style.left = `${prefs.panelLeft}px`;
    userPanel.style.top = `${prefs.panelTop}px`;
    userPanel.style.right = 'auto';
  }
  // Restore panel width/height (corner-resize)
  if (userPanel) {
    if (prefs.panelWidth != null) userPanel.style.width = `${prefs.panelWidth}px`;
    if (prefs.panelHeight != null) userPanel.style.height = `${prefs.panelHeight}px`;
  }

  // ── Panel zoom (Cmd+scroll) ──
  let panelScale = prefs.panelScale;
  state.panelScale = panelScale;
  function applyScale(): void {
    if (!userPanel) return;
    userPanel.style.transform = `scale(${panelScale})`;
    userPanel.style.transformOrigin = 'top left';
    state.panelScale = panelScale;
    // Update zoom UI if it exists (called before zoom controls are wired)
    const lbl = document.getElementById('cv-zoom-label');
    const sld = document.getElementById('cv-zoom-slider') as HTMLInputElement | null;
    const pct = Math.round(panelScale * 100);
    if (lbl) lbl.textContent = `${pct}%`;
    if (sld) sld.value = String(pct);
  }
  applyScale();

  if (userPanel) {
    userPanel.addEventListener('wheel', (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      panelScale = Math.min(4, Math.max(0.5, panelScale + delta));
      applyScale();
      savePrefs({ panelScale });
    }, { passive: false });
  }

  // ── Fit the fixed-200px virtual board to whatever size its leaf gets ──
  const boardFit = document.getElementById('cv-board-fit') as HTMLElement | null;
  const boardContainer = boardFit?.querySelector<HTMLElement>('.board-container') ?? null;
  if (boardFit && boardContainer) {
    const observer = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        const scale = Math.max(0, Math.min(width, height) / 200);
        boardContainer.style.setProperty('--board-scale', String(scale));
        state.boardScale = scale;
        renderArrows(state);
      }
    });
    observer.observe(boardFit);
  }

  // ── View switcher (moves / settings / debug) ──
  // The panel has three exclusive views; ⚙ and 🐛 in the header swap them.
  // Clicking the active button (or ←) returns to moves.
  const viewMoves    = document.getElementById('r2-view-moves');
  const viewSettings = document.getElementById('r2-view-settings');
  const viewDebug    = document.getElementById('r2-view-debug');
  const btnSettings  = document.getElementById('r2-btn-settings');
  const btnDebug     = document.getElementById('r2-btn-debug');
  function showView(name: 'moves' | 'settings' | 'debug'): void {
    if (viewMoves)    viewMoves.hidden    = name !== 'moves';
    if (viewSettings) viewSettings.hidden = name !== 'settings';
    if (viewDebug)    viewDebug.hidden    = name !== 'debug';
    btnSettings?.classList.toggle('active', name === 'settings');
    btnDebug?.classList.toggle('active', name === 'debug');
  }
  btnSettings?.addEventListener('click', () => {
    showView(viewSettings?.hidden === false ? 'moves' : 'settings');
  });
  btnDebug?.addEventListener('click', () => {
    showView(viewDebug?.hidden === false ? 'moves' : 'debug');
  });
  document.getElementById('r2-back-settings')?.addEventListener('click', () => showView('moves'));
  document.getElementById('r2-back-debug')?.addEventListener('click', () => showView('moves'));

  // ── Resize grips (drag corners to resize panel width/height) ──
  // `anchorRight`/`anchorBottom` mean the OPPOSITE edge is anchored, so dragging the grip
  // moves the matching edge. For anchored-left/top we only change width/height; for
  // anchored-right/bottom we also shift the panel's top-left to keep the opposite edge fixed.
  const MIN_W = 220, MIN_H = 240;
  function setupResizeGrip(gripId: string, anchorRight: boolean, anchorBottom: boolean): void {
    const grip = document.getElementById(gripId);
    if (!grip || !userPanel) return;

    let resizing = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;
    let startW = 0, startH = 0;

    grip.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startLeft = userPanel!.offsetLeft; startTop = userPanel!.offsetTop;
      startW = userPanel!.offsetWidth; startH = userPanel!.offsetHeight;
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!resizing) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newW = anchorRight ? startW - dx : startW + dx;
      let newH = anchorBottom ? startH - dy : startH + dy;
      newW = Math.max(MIN_W, newW);
      newH = Math.max(MIN_H, newH);

      userPanel!.style.width = `${newW}px`;
      userPanel!.style.height = `${newH}px`;
      if (anchorRight) {
        userPanel!.style.left = `${startLeft + (startW - newW)}px`;
        userPanel!.style.right = 'auto';
      }
      if (anchorBottom) {
        userPanel!.style.top = `${startTop + (startH - newH)}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        document.body.style.userSelect = '';
        savePrefs({
          panelWidth: userPanel!.offsetWidth,
          panelHeight: userPanel!.offsetHeight,
          panelLeft: userPanel!.offsetLeft,
          panelTop: userPanel!.offsetTop,
        });
      }
    });
  }
  setupResizeGrip('cv-resize-grip-br', false, false);
  setupResizeGrip('cv-resize-grip-bl', true, false);
  setupResizeGrip('cv-resize-grip-tr', false, true);
  setupResizeGrip('cv-resize-grip-tl', true, true);

  // ── Zoom controls ──
  function setZoom(scale: number): void {
    panelScale = Math.min(4, Math.max(0.5, scale));
    applyScale(); savePrefs({ panelScale });
  }

  document.getElementById('cv-zoom-in')?.addEventListener('click', () => setZoom(panelScale + 0.1));
  document.getElementById('cv-zoom-out')?.addEventListener('click', () => setZoom(panelScale - 0.1));

  // Restore visual state from prefs
  if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';
  if (state.canvas) state.canvas.style.display = state.vboardOverlayVisible ? '' : 'none';

  // Section headers are now drag handles for gridstack; hide uses the × button
  // and re-add uses the hidden-sections tray.

  // ── Overlay/Box toggles (debug panel) ──
  const overlayBtn = document.getElementById('cv-overlay-btn');
  const childToggles = document.querySelectorAll('#cv-eval-btn');

  function updateChildToggles(): void {
    childToggles.forEach(btn => btn.classList.toggle('parent-hidden', !state.overlayVisible));
  }

  // Actual board overlay toggle
  if (overlayBtn) {
    overlayBtn.classList.toggle('active', state.overlayVisible);
    updateChildToggles();
    overlayBtn.addEventListener('click', () => {
      state.overlayVisible = !state.overlayVisible;
      if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';
      overlayBtn.classList.toggle('active', state.overlayVisible);
      updateChildToggles();
      syncDisplayToggles();
      savePrefs({ overlayVisible: state.overlayVisible });
      if (state.overlayVisible) {
        (window as any).__chessrayResetAutoTimer?.();
        if (state.lineVisible) pvCycleStart();
      } else {
        // Stop everything only if both overlays are hidden
        if (!state.vboardOverlayVisible) {
          (window as any).__chessrayClearAutoTimer?.();
          pvCycleStop();
        }
      }
    });
  }

  // Virtual board overlay toggle
  const vboardBtn = document.getElementById('cv-vboard-btn');
  state.vboardOverlayVisible = prefs.vboardOverlayVisible;
  if (state.canvas) state.canvas.style.display = state.vboardOverlayVisible ? '' : 'none';

  if (vboardBtn) {
    vboardBtn.classList.toggle('active', state.vboardOverlayVisible);
    vboardBtn.addEventListener('click', () => {
      state.vboardOverlayVisible = !state.vboardOverlayVisible;
      if (state.canvas) state.canvas.style.display = state.vboardOverlayVisible ? '' : 'none';
      document.querySelectorAll('.piece-anim').forEach(el => el.remove());
      vboardBtn.classList.toggle('active', state.vboardOverlayVisible);
      syncDisplayToggles();
      savePrefs({ vboardOverlayVisible: state.vboardOverlayVisible });
      if (state.vboardOverlayVisible) {
        // Redraw virtual board arrows if cycle is running
        renderArrows(state);
        if (state.lineVisible && !pvCycleTimer) pvCycleStart();
      } else {
        // Clean up virtual board visuals only — keep the cycle running so the
        // actual-board piece animation continues uninterrupted.
        document.querySelectorAll('.piece-anim').forEach(el => el.remove());
        if (state.canvas) {
          const ctx = state.canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        }
      }
    });
  }

  const borderBtn = document.getElementById('cv-border-btn');
  if (borderBtn) {
    borderBtn.classList.toggle('active', state.borderVisible);
    borderBtn.addEventListener('click', () => {
      state.borderVisible = !state.borderVisible;
      borderBtn.classList.toggle('active', state.borderVisible);
      savePrefs({ borderVisible: state.borderVisible });
    });
  }

  // Copy debug button — copies a Markdown + JSON report of the currently shown
  // debug view (live frame or selected history entry) to the clipboard.
  const copyBtn = document.getElementById('cv-copy-debug-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const inHistory = historyIndex !== null;
      const entry = inHistory ? debugHistory[historyIndex!] : null;
      const result = entry ? snapshotToResult(entry) : state.currentResult;
      if (!result) {
        copyBtn.textContent = 'No data';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        return;
      }
      const report = formatDebugReport(result, inHistory && entry
        ? { source: 'history', historyIndex: historyIndex!, historyCount: debugHistory.length, ageLabel: ageLabel(entry.captured_at) }
        : { source: 'live' });
      try {
        await navigator.clipboard.writeText(report);
        copyBtn.textContent = '✓ Copied';
        copyBtn.classList.add('active');
      } catch (err) {
        console.error('[chessray] Copy debug failed', err);
        copyBtn.textContent = 'Copy failed';
      }
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('active');
      }, 1200);
    });
  }

  // Debug board-preview image scale slider — applies to the cropped preview only.
  const debugImgScale = document.getElementById('cv-debug-img-scale') as HTMLInputElement | null;
  const debugImgScaleVal = document.getElementById('cv-debug-img-scale-val');
  const debugImgEl = document.getElementById('cv-debug-img') as HTMLImageElement | null;
  if (debugImgScale && debugImgScaleVal && debugImgEl) {
    const apply = (pct: number): void => {
      debugImgEl.style.width = `${pct}%`;
      debugImgScaleVal.textContent = String(pct);
    };
    apply(prefs.debugImgScale);
    debugImgScale.value = String(prefs.debugImgScale);
    debugImgScale.addEventListener('input', () => {
      const pct = parseInt(debugImgScale.value, 10);
      apply(pct);
      savePrefs({ debugImgScale: pct });
    });
  }

  // Record toggle — start/stop dumping raw captured frames to disk
  const recordBtn = document.getElementById('cv-record-btn');
  let recordingActive = false;
  if (recordBtn) {
    recordBtn.addEventListener('click', () => {
      if (recordingActive) window.chessRay.stopRecording();
      else window.chessRay.startRecording();
    });
  }
  window.chessRay.onRecordingStateChanged((active: boolean, sessionDir: string | null) => {
    recordingActive = active;
    if (recordBtn) {
      recordBtn.classList.toggle('active', active);
      recordBtn.textContent = active ? '⏺ Recording' : '● Record';
      if (active && sessionDir) {
        recordBtn.setAttribute('data-tip', `Recording to ${sessionDir}`);
      } else {
        recordBtn.setAttribute('data-tip', 'Dump raw captured frames to ~/chessray-recordings/ for test fixtures');
      }
    }
  });

  const pvDepthSlider = document.getElementById('cv-pv-depth') as HTMLInputElement | null;
  const pvDepthVal = document.getElementById('cv-pv-depth-val');

  // ── Display section checkboxes ──
  const dispOverlay = document.getElementById('cv-disp-overlay') as HTMLInputElement | null;
  const dispVboard = document.getElementById('cv-disp-vboard') as HTMLInputElement | null;
  const dispEval = document.getElementById('cv-disp-eval') as HTMLInputElement | null;

  function syncDisplayToggles(): void {
    if (dispOverlay) dispOverlay.checked = state.overlayVisible;
    if (dispVboard) dispVboard.checked = state.vboardOverlayVisible;
    if (dispEval) dispEval.checked = state.evalBarVisible;
  }

  dispOverlay?.addEventListener('change', () => document.getElementById('cv-overlay-btn')?.click());
  dispVboard?.addEventListener('change', () => document.getElementById('cv-vboard-btn')?.click());
  dispEval?.addEventListener('change', () => document.getElementById('cv-eval-btn')?.click());

  if (pvDepthSlider && pvDepthVal) {
    const PV_ALL = 999;
    const sliderVal = state.pvDepth >= PV_ALL ? 11 : state.pvDepth;
    pvDepthSlider.value = String(sliderVal);
    pvDepthVal.textContent = state.pvDepth >= PV_ALL ? 'All' : String(state.pvDepth);
    pvDepthSlider.addEventListener('input', () => {
      const raw = parseInt(pvDepthSlider.value, 10);
      state.pvDepth = raw >= 11 ? PV_ALL : raw;
      pvDepthVal.textContent = state.pvDepth >= PV_ALL ? 'All' : String(state.pvDepth);
      savePrefs({ pvDepth: state.pvDepth });
      renderArrows(state);
    });
  }

  // ── Unified PV line cycle ──
  // In line mode, the actual board and virtual board animate in sync:
  // - Actual board: arrows grow one by one (1, 2, 3... up to pvDepth)
  // - Virtual board: shows position after N moves with arrow+highlight for move N
  // When the sequence completes, both reset and loop.
  const pvGrowSlider = document.getElementById('cv-pv-grow-delay') as HTMLInputElement | null;
  const pvGrowVal = document.getElementById('cv-pv-grow-delay-val');
  let pvGrowDelaySec = prefs.pvGrowDelaySec;
  const pvPreviewSlider = document.getElementById('cv-pv-preview-sec') as HTMLInputElement | null;
  const pvPreviewVal = document.getElementById('cv-pv-preview-sec-val');
  let pvPreviewSec = prefs.pvPreviewSec;
  let pvCycleTimer: ReturnType<typeof setInterval> | null = null;
  let pvCycleLastPv: string[] = [];
  let pvCycleBaseFen = '';
  let pvCycleFlipped = false;
  let pvCyclePv: string[] = [];

  let pvCycleMovesTimer: ReturnType<typeof setTimeout> | null = null;
  let pvCyclePreviewTimer: ReturnType<typeof setTimeout> | null = null;
  let pvCycleLineIndex = 0;

  /** Get line indices eligible for cycling (filtered by loss threshold) */
  function getCycleLineIndices(): number[] {
    const moves = state.currentResult?.evaluation?.top_moves;
    if (!moves?.length) return [];
    const indices: number[] = [];
    for (let i = 0; i < moves.length; i++) {
      if (moves[i].loss_cp <= state.lossThreshold) indices.push(i);
    }
    return indices;
  }

  let pvCycleArrowsWas = false; // remember arrows state before interlude

  /** Advance to next line, show moves in between, then start animating */
  function pvCycleNextLine(): void {
    const indices = getCycleLineIndices();
    if (indices.length === 0) return;

    if (userLockedLine >= 0) {
      // User explicitly picked this line (arrow/pill click) — play once and
      // stop; do not loop. Auto-cycle (userLockedLine < 0) keeps rotating.
      stopPvLine();
      return;
    }
    // Advance to next line in the cycle
    const curPos = indices.indexOf(pvCycleLineIndex);
    const nextPos = (curPos + 1) % indices.length;
    pvCycleLineIndex = indices[nextPos];
    state.selectedLineIndex = pvCycleLineIndex;

    // Exit analysis view for the interlude
    (window as any).__chessrayPvPlaying = false;
    document.getElementById('cv-debug-grid')?.classList.remove('analysis');
    document.querySelectorAll('.piece-anim').forEach(el => el.remove());

    // Show moves briefly between lines
    pvCycleArrowsWas = state.arrowsVisible;
    state.arrowsVisible = true;
    state.lineVisible = false;
    renderArrows(state);
    renderVideoOverlay(state);
    updateCompactMoves();

    pvCycleMovesTimer = setTimeout(() => {
      pvCycleMovesTimer = null;
      state.arrowsVisible = pvCycleArrowsWas;
      state.lineVisible = true;
      pvCycleStartCurrentLine();
    }, autoDelaySec * 1000);
  }

  function pvCycleStep(): void {
    // If the cached PV has diverged from the live eval (deeper search changed
    // this line's moves at the same index), stop instead of silently restarting
    // the same line from step 1 — user sees "animation reset" without any
    // sense that the line's content has actually changed.
    const liveResult = state.currentResult;
    if (liveResult?.evaluation?.top_moves?.length) {
      const idx = Math.min(pvCycleLineIndex, liveResult.evaluation.top_moves.length - 1);
      const livePv = liveResult.evaluation.top_moves[idx].pv;
      const depth = Math.max(state.pvDisplayDepth, 1);
      const stale = depth > livePv.length ||
        pvCyclePv.slice(0, depth).some((m, i) => m !== livePv[i]);
      if (stale) {
        stopPvLine();
        return;
      }
    }

    if (state.pvDisplayDepth >= state.pvDepth || state.pvDisplayDepth >= pvCyclePv.length) {
      // Sequence complete
      if (pvCycleTimer !== null) { clearInterval(pvCycleTimer); pvCycleTimer = null; }
      state.pvDisplayDepth = 0;

      // Clear actual board overlay
      state.pvBoardState = null;
      renderVideoOverlay(state);

      // Reset virtual board if visible
      if (state.vboardOverlayVisible) {
        const grid = document.getElementById('cv-debug-grid');
        if (grid) renderBoardGrid(grid, pvCycleBaseFen.split(' ')[0], pvCycleFlipped, [], state.currentResult?.square_colors);
        if (state.canvas) {
          const ctx = state.canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        }
      }

      // Advance to next line (with moves interlude)
      pvCycleNextLine();
      return;
    }

    state.pvDisplayDepth++;
    const step = state.pvDisplayDepth;

    // ── Shared computation for both actual and virtual board ──

    const uci = pvCyclePv[step - 1];
    const fromSq = uci.slice(0, 2);
    const toSq = uci.slice(2, 4);

    // Get the board position BEFORE this move (step-1 moves applied)
    const beforePos = step === 1
      ? { fen: pvCycleBaseFen.split(' ')[0], highlight: [] as number[] }
      : applyUciMoves(pvCycleBaseFen, pvCyclePv, step - 1);
    if (!beforePos) { pvCycleStop(); return; }

    // Get the board position AFTER this move
    const afterPos = applyUciMoves(pvCycleBaseFen, pvCyclePv, step);
    if (!afterPos) { pvCycleStop(); return; }

    // Figure out which piece is moving (from the before position)
    const beforeRows = beforePos.fen.split('/');
    const fromFile = fromSq.charCodeAt(0) - 97;
    const fromRank = 8 - parseInt(fromSq[1]);
    let movingPiece = '';
    {
      let file = 0;
      for (const ch of beforeRows[fromRank]) {
        if (ch >= '1' && ch <= '8') { file += parseInt(ch); }
        else { if (file === fromFile) { movingPiece = ch; break; } file++; }
      }
    }

    const fromIdx = fromRank * 8 + fromFile;
    const toFileN = toSq.charCodeAt(0) - 97;
    const toRankN = 8 - parseInt(toSq[1]);
    const toIdx = toRankN * 8 + toFileN;

    // Build a FEN with the moving piece removed from source
    const pickedUpFen = beforePos.fen.split('/').map((row, rank) => {
      if (rank !== fromRank) return row;
      let result = '';
      let file = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          const n = parseInt(ch);
          for (let i = 0; i < n; i++) {
            result += file === fromFile ? '1' : '1';
            file++;
          }
        } else {
          result += file === fromFile ? '1' : ch;
          file++;
        }
      }
      // Compress consecutive 1s
      return result.replace(/1+/g, m => String(m.length));
    }).join('/');

    const turn = pvCycleBaseFen.split(' ')[1] || 'w';
    const isWhite = (step % 2 === 1) === (turn === 'w');

    // ── Actual board overlay animation ──

    state.pvBoardState = {
      fen: pickedUpFen,
      flipped: pvCycleFlipped,
      highlight: [fromIdx, toIdx],
      squareColors: state.currentResult?.square_colors,
      anim: movingPiece ? {
        piece: movingPiece, fromSq, toSq, isWhite, step,
        progress: 0,
        afterFen: afterPos.fen,
        afterHighlight: afterPos.highlight,
      } : null,
    };
    renderVideoOverlay(state);

    if (movingPiece) {
      const TRANSITION_MS = 350;
      const startTime = performance.now();
      function easeInOut(t: number): number { return t * t * (3 - 2 * t); }

      function tickActualBoard(): void {
        if (!(window as any).__chessrayPvPlaying || !state.pvBoardState?.anim || state.pvBoardState.anim.step !== step) return;
        const elapsed = performance.now() - startTime;
        const progress = easeInOut(Math.min(1, elapsed / TRANSITION_MS));
        state.pvBoardState.anim.progress = progress;
        renderVideoOverlay(state);

        if (progress < 1) {
          requestAnimationFrame(tickActualBoard);
        }
        // When progress = 1, stop the loop but keep anim at progress=1
        // so the arrow label stays visible until the next step overwrites pvBoardState
      }
      requestAnimationFrame(tickActualBoard);
    }

    // ── Virtual board animation (skip if hidden) ──

    if (!state.vboardOverlayVisible) return;

    const grid = document.getElementById('cv-debug-grid');
    const container = grid?.parentElement;
    if (!grid || !container) { pvCycleStop(); return; }

    renderBoardGrid(grid, pickedUpFen, pvCycleFlipped, [fromIdx, toIdx], state.currentResult?.square_colors);

    // Compute pixel positions for source and destination squares
    const sq = 25; // grid square size in CSS px
    let srcFile = fromFile, srcRank = fromRank, dstFile = toFileN, dstRank = toRankN;
    if (pvCycleFlipped) {
      srcFile = 7 - srcFile; srcRank = 7 - srcRank;
      dstFile = 7 - dstFile; dstRank = 7 - dstRank;
    }

    // Fade the captured piece on the destination square in lockstep with the
    // floating piece's slide so the new piece doesn't appear to land on top
    // of it. If the destination is empty (non-capture), this is a no-op.
    const dstSq = grid.children[dstRank * 8 + dstFile] as HTMLElement | undefined;
    const capturedSvg = dstSq?.querySelector('svg') as SVGElement | null;
    if (capturedSvg) {
      capturedSvg.style.transition = 'opacity 350ms linear';
      requestAnimationFrame(() => { capturedSvg.style.opacity = '0'; });
    }

    // Create floating piece at source
    const floater = document.createElement('div');
    floater.className = 'piece-anim';
    floater.style.width = `${sq}px`;
    floater.style.height = `${sq}px`;
    floater.style.left = `${srcFile * sq}px`;
    floater.style.top = `${srcRank * sq}px`;
    floater.innerHTML = movingPiece ? pieceSvg(movingPiece, 22) : '';
    container.appendChild(floater);

    // Trigger animation to destination
    requestAnimationFrame(() => {
      floater.style.left = `${dstFile * sq}px`;
      floater.style.top = `${dstRank * sq}px`;
    });

    // On transition end, render final board and remove floater
    floater.addEventListener('transitionend', () => {
      floater.remove();
      if ((window as any).__chessrayPvPlaying) {
        renderBoardGrid(grid, afterPos.fen, pvCycleFlipped, afterPos.highlight, state.currentResult?.square_colors);
      }
    }, { once: true });
    // Fallback if transitionend doesn't fire
    setTimeout(() => {
      if (floater.parentElement) {
        floater.remove();
        if ((window as any).__chessrayPvPlaying) {
          renderBoardGrid(grid, afterPos.fen, pvCycleFlipped, afterPos.highlight, state.currentResult?.square_colors);
        }
      }
    }, 500);

    // Animate arrow following piece movement on virtual board canvas
    if (state.canvas) {
      const ARROW_BASE_OPACITY = 0.8;
      const moveArrow = {
        from: fromSq, to: toSq,
        color: isWhite ? '#e5e5e5' : '#1a1a1a',
        width: 3, opacity: ARROW_BASE_OPACITY, loss_cp: 0,
        label: String(step),
      };
      const VB_TRANSITION_MS = 350;
      const vbStartTime = performance.now();

      function tickArrow(): void {
        if (!state.canvas || !(window as any).__chessrayPvPlaying) return;
        const elapsed = performance.now() - vbStartTime;
        const raw = Math.min(1, elapsed / VB_TRANSITION_MS);
        const progress = raw * raw * (3 - 2 * raw);

        const size = 200;
        const dpr = window.devicePixelRatio || 1;
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
        // Sine-bell opacity: fade in, peak mid-movement, fade out
        const bellOpacity = ARROW_BASE_OPACITY * Math.sin(Math.PI * progress);
        drawArrow(ctx, { ...moveArrow, opacity: bellOpacity }, { x: 0, y: 0, width: size, height: size }, 1, state.displayFlipped, 0, progress, true);

        if (progress < 1) requestAnimationFrame(tickArrow);
      }
      requestAnimationFrame(tickArrow);
    }
  }

  /** Start animating the current pvCycleLineIndex */
  function pvCycleStartCurrentLine(): void {
    if (pvCycleTimer !== null) { clearInterval(pvCycleTimer); pvCycleTimer = null; }
    if (pvCyclePreviewTimer !== null) { clearTimeout(pvCyclePreviewTimer); pvCyclePreviewTimer = null; state.pvPreviewLineIndex = null; }
    if (!state.lineVisible) return;
    const result = state.currentResult;
    if (!result?.evaluation?.top_moves?.length) return;
    const idx = Math.min(pvCycleLineIndex, result.evaluation.top_moves.length - 1);
    const pv = result.evaluation.top_moves[idx].pv;
    const baseFen = result.evaluation.fen;
    if (!baseFen || pv.length === 0) return;

    pvCyclePv = [...pv];
    pvCycleBaseFen = baseFen;
    pvCycleFlipped = !!result.flipped;
    pvCycleLastPv = [...pv];
    state.pvDisplayDepth = 0;

    // Preview phase: show the selected line's first move arrow only
    // pvPreviewLineIndex drives getActiveArrows — no need to touch arrowsVisible/lineVisible
    state.pvPreviewLineIndex = idx;
    renderArrows(state);
    renderVideoOverlay(state);

    pvCyclePreviewTimer = setTimeout(() => {
      pvCyclePreviewTimer = null;
      state.pvPreviewLineIndex = null;
      (window as any).__chessrayPvPlaying = true;
      if (state.vboardOverlayVisible) {
        document.getElementById('cv-debug-grid')?.classList.add('analysis');
      }

      // First step immediately, then continue on interval
      pvCycleStep();
      pvCycleTimer = setInterval(pvCycleStep, pvGrowDelaySec * 1000);
    }, pvPreviewSec * 1000);
  }

  /** Start the unified cycle from the selected line */
  function pvCycleStart(): void {
    pvCycleStop();
    pvCycleLineIndex = state.selectedLineIndex;
    pvCycleStartCurrentLine();
  }

  /** Continue if displayed moves match, otherwise restart */
  function pvCycleContinue(): void {
    if (!state.lineVisible) return;
    const result = state.currentResult;
    if (!result?.evaluation?.top_moves?.length) return;
    const idx = Math.min(pvCycleLineIndex, result.evaluation.top_moves.length - 1);
    const newPv = result.evaluation.top_moves[idx].pv;
    // Check that all moves we've already displayed still match the new PV
    const depth = Math.max(state.pvDisplayDepth, 1); // always check at least the first move
    const displayedMatch = depth <= newPv.length &&
      pvCycleLastPv.slice(0, depth).every((m, i) => m === newPv[i]);
    if (displayedMatch) {
      pvCycleLastPv = [...newPv];
      pvCyclePv = [...newPv];
      pvCycleBaseFen = result.evaluation.fen || pvCycleBaseFen;
    } else {
      pvCycleStart();
    }
  }

  function pvCycleStop(): void {
    if (pvCycleTimer !== null) { clearInterval(pvCycleTimer); pvCycleTimer = null; }
    if (pvCyclePreviewTimer !== null) {
      clearTimeout(pvCyclePreviewTimer); pvCyclePreviewTimer = null;
      state.pvPreviewLineIndex = null;
    }
    if (pvCycleMovesTimer !== null) {
      clearTimeout(pvCycleMovesTimer); pvCycleMovesTimer = null;
      state.arrowsVisible = pvCycleArrowsWas;
    }
    const wasPlaying = (window as any).__chessrayPvPlaying;
    (window as any).__chessrayPvPlaying = false;
    // Clear actual board overlay
    state.pvBoardState = null;
    const grid = document.getElementById('cv-debug-grid');
    grid?.classList.remove('analysis');
    document.querySelectorAll('.piece-anim').forEach(el => el.remove());
    // Restore board grid to base position (before animation moved pieces)
    if (wasPlaying && pvCycleBaseFen && grid) {
      renderBoardGrid(grid, pvCycleBaseFen.split(' ')[0], pvCycleFlipped, [], state.currentResult?.square_colors);
    }
    if (wasPlaying) {
      state.pvDisplayDepth = state.pvDepth; // restore full depth
      renderArrows(state);
      renderVideoOverlay(state);
    }
  }

  (window as any).__chessrayPvGrowStart = pvCycleStart;
  (window as any).__chessrayPvGrowContinue = pvCycleContinue;
  (window as any).__chessrayPvGrowStop = pvCycleStop;
  (window as any).__chessrayPvPlayStop = pvCycleStop;

  if (pvGrowSlider && pvGrowVal) {
    pvGrowSlider.value = String(pvGrowDelaySec);
    pvGrowVal.textContent = String(pvGrowDelaySec);
    pvGrowSlider.addEventListener('input', () => {
      pvGrowDelaySec = parseInt(pvGrowSlider.value, 10);
      pvGrowVal.textContent = String(pvGrowDelaySec);
      savePrefs({ pvGrowDelaySec });
      pvCycleStart();
    });
  }

  if (pvPreviewSlider && pvPreviewVal) {
    pvPreviewSlider.value = String(pvPreviewSec);
    pvPreviewVal.textContent = String(pvPreviewSec);
    pvPreviewSlider.addEventListener('input', () => {
      pvPreviewSec = parseInt(pvPreviewSlider.value, 10);
      pvPreviewVal.textContent = String(pvPreviewSec);
      savePrefs({ pvPreviewSec });
      // No need to restart the cycle — the new value picks up on the next preview phase.
    });
  }

  // ── Show moves delay ──
  const showMovesSlider = document.getElementById('cv-show-moves-delay') as HTMLInputElement | null;
  const showMovesVal = document.getElementById('cv-show-moves-delay-val');
  showMovesDelaySec = prefs.showMovesDelaySec;

  if (showMovesSlider && showMovesVal) {
    showMovesSlider.value = String(showMovesDelaySec);
    showMovesVal.textContent = String(showMovesDelaySec);
    showMovesSlider.addEventListener('input', () => {
      showMovesDelaySec = parseInt(showMovesSlider.value, 10);
      showMovesVal.textContent = String(showMovesDelaySec);
      savePrefs({ showMovesDelaySec });
    });
  }

  // ── Loss threshold slider ──
  const lossSlider = document.getElementById('cv-loss-threshold') as HTMLInputElement | null;
  const lossVal = document.getElementById('cv-loss-threshold-val');
  state.lossThreshold = prefs.lossThreshold;
  if (lossSlider && lossVal) {
    lossSlider.value = String(state.lossThreshold);
    lossVal.textContent = String(state.lossThreshold);
    lossSlider.addEventListener('input', () => {
      state.lossThreshold = parseInt(lossSlider.value, 10);
      lossVal.textContent = String(state.lossThreshold);
      savePrefs({ lossThreshold: state.lossThreshold });
      renderArrows(state);
      renderVideoOverlay(state);
    });
  }

  const evalBtn = document.getElementById('cv-eval-btn');
  if (evalBtn) {
    evalBtn.classList.toggle('active', state.evalBarVisible);
    evalBtn.addEventListener('click', () => {
      state.evalBarVisible = !state.evalBarVisible;
      evalBtn.classList.toggle('active', state.evalBarVisible);
      syncDisplayToggles();
      savePrefs({ evalBarVisible: state.evalBarVisible });
    });
  }

  // ── MultiPV max slider ──
  const multiPvSlider = document.getElementById('cv-multi-pv-max') as HTMLInputElement | null;
  const multiPvVal = document.getElementById('cv-multi-pv-max-val');
  if (multiPvSlider && multiPvVal) {
    multiPvSlider.value = String(prefs.multiPvMax);
    multiPvVal.textContent = String(prefs.multiPvMax);
    window.chessRay.setMultiPvMax(prefs.multiPvMax);
    multiPvSlider.addEventListener('input', () => {
      const n = parseInt(multiPvSlider.value, 10);
      multiPvVal.textContent = String(n);
      savePrefs({ multiPvMax: n });
      window.chessRay.setMultiPvMax(n);
    });
  }

  // ── Change detection toggle ──
  const changeDetectCheckbox = document.getElementById('cv-change-detect') as HTMLInputElement | null;
  if (changeDetectCheckbox) {
    changeDetectCheckbox.checked = prefs.changeDetect;
    window.chessRay.setChangeDetect(prefs.changeDetect);
    changeDetectCheckbox.addEventListener('change', () => {
      savePrefs({ changeDetect: changeDetectCheckbox.checked });
      window.chessRay.setChangeDetect(changeDetectCheckbox.checked);
    });
  }

  // ── Overlay size / opacity sliders ──
  // Control all on-board decorations: arrows, PV step labels, played-move markers.
  const overlaySizeSlider = document.getElementById('cv-overlay-size') as HTMLInputElement | null;
  const overlaySizeVal = document.getElementById('cv-overlay-size-val');
  if (overlaySizeSlider && overlaySizeVal) {
    overlaySizeSlider.value = String(state.overlaySize);
    overlaySizeVal.textContent = String(state.overlaySize);
    overlaySizeSlider.addEventListener('input', () => {
      const v = parseInt(overlaySizeSlider.value, 10);
      state.overlaySize = v;
      overlaySizeVal.textContent = String(v);
      savePrefs({ overlaySize: v });
      renderArrows(state);
      renderVideoOverlay(state);
    });
  }
  const overlayOpacitySlider = document.getElementById('cv-overlay-opacity') as HTMLInputElement | null;
  const overlayOpacityVal = document.getElementById('cv-overlay-opacity-val');
  if (overlayOpacitySlider && overlayOpacityVal) {
    overlayOpacitySlider.value = String(Math.round(state.overlayOpacity * 100));
    overlayOpacityVal.textContent = String(Math.round(state.overlayOpacity * 100));
    overlayOpacitySlider.addEventListener('input', () => {
      const pct = parseInt(overlayOpacitySlider.value, 10);
      state.overlayOpacity = pct / 100;
      overlayOpacityVal.textContent = String(pct);
      savePrefs({ overlayOpacity: state.overlayOpacity });
      renderArrows(state);
      renderVideoOverlay(state);
    });
  }
  const evalStaleSlider = document.getElementById('cv-eval-stale-opacity') as HTMLInputElement | null;
  const evalStaleVal = document.getElementById('cv-eval-stale-opacity-val');
  if (evalStaleSlider && evalStaleVal) {
    evalStaleSlider.value = String(Math.round(state.evalBarStaleOpacity * 100));
    evalStaleVal.textContent = String(Math.round(state.evalBarStaleOpacity * 100));
    evalStaleSlider.addEventListener('input', () => {
      const pct = parseInt(evalStaleSlider.value, 10);
      state.evalBarStaleOpacity = pct / 100;
      evalStaleVal.textContent = String(pct);
      savePrefs({ evalBarStaleOpacity: state.evalBarStaleOpacity });
      renderVideoOverlay(state);
    });
  }

  // ── Frame rate ceiling (auto-tuner floor is hardcoded to 1) ──
  const fpsMaxSlider = document.getElementById('cv-fps-max') as HTMLInputElement | null;
  const fpsMaxVal = document.getElementById('cv-fps-max-val');
  fpsRange.min = 1;
  fpsRange.max = Math.max(1, prefs.fpsMax ?? 5);
  setActiveFps(clamp(prefs.targetFps ?? fpsRange.min, fpsRange.min, fpsRange.max));
  if (fpsMaxSlider && fpsMaxVal) {
    fpsMaxSlider.value = String(fpsRange.max);
    fpsMaxVal.textContent = String(fpsRange.max);
    fpsMaxSlider.addEventListener('input', () => {
      const v = parseInt(fpsMaxSlider.value, 10);
      fpsRange.max = Math.max(1, v);
      fpsMaxVal.textContent = String(fpsRange.max);
      savePrefs({ fpsMax: fpsRange.max });
      setActiveFps(clamp(activeFps, fpsRange.min, fpsRange.max));
    });
  }

  // Initial render of the history nav (shows nothing until the first slow frame).
  refreshHistoryNav(document.getElementById('cv-debug-history-nav'));

  // ── Auto cycle: always show moves, then switch to PV animation after delay ──
  const autoDelaySlider = document.getElementById('cv-auto-delay') as HTMLInputElement | null;
  const autoDelayVal = document.getElementById('cv-auto-delay-val');

  let autoDelaySec = prefs.autoDelaySec;
  let pvAutoplay = prefs.pvAutoplay;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;

  function resetAutoTimer(): void {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
    if (!state.overlayVisible && !state.vboardOverlayVisible) return;

    state.arrowsVisible = true;
    state.lineVisible = false;
    pvCycleStop();
    renderArrows(state);
    renderVideoOverlay(state);

    if (!pvAutoplay) return;

    autoTimer = setTimeout(() => {
      autoTimer = null;
      state.arrowsVisible = false;
      state.lineVisible = true;
      pvCycleStart();
      renderArrows(state);
      renderVideoOverlay(state);
    }, autoDelaySec * 1000);
  }

  (window as any).__chessrayResetAutoTimer = resetAutoTimer;
  (window as any).__chessrayClearAutoTimer = () => {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
  };

  if (autoDelaySlider && autoDelayVal) {
    autoDelaySlider.value = String(autoDelaySec);
    autoDelayVal.textContent = String(autoDelaySec);
    autoDelaySlider.addEventListener('input', () => {
      autoDelaySec = parseInt(autoDelaySlider.value, 10);
      autoDelayVal.textContent = String(autoDelaySec);
      savePrefs({ autoDelaySec });
      resetAutoTimer();
    });
  }

  const pvAutoplayCheckbox = document.getElementById('cv-pv-autoplay') as HTMLInputElement | null;
  const autoDelayRow = document.getElementById('cv-auto-delay-row');
  function applyPvAutoplayUI(): void {
    if (autoDelayRow) autoDelayRow.style.display = pvAutoplay ? '' : 'none';
  }
  if (pvAutoplayCheckbox) {
    pvAutoplayCheckbox.checked = pvAutoplay;
    pvAutoplayCheckbox.addEventListener('change', () => {
      pvAutoplay = pvAutoplayCheckbox.checked;
      savePrefs({ pvAutoplay });
      applyPvAutoplayUI();
      resetAutoTimer();
    });
  }
  applyPvAutoplayUI();


  // ── Collapse panel ──
  const collapseBtn = document.getElementById('cv-collapse-btn');
  const panelBody = document.getElementById('cv-panel-body');
  let collapsed = prefs.collapsed;

  // ── Compact mode ──
  const compactBtn = document.getElementById('cv-compact-btn');
  const compactMovesEl = document.getElementById('cv-compact-moves');
  let compactMode = prefs.compactMode;

  function setCollapsed(c: boolean): void {
    if (c && compactMode) setCompactMode(false);
    collapsed = c;
    panelBody?.classList.toggle('hidden', c);
    userPanel?.classList.toggle('collapsed', c);
    collapseBtn?.classList.toggle('collapsed', c);
    savePrefs({ collapsed: c });
  }

  const compactHintEl = document.getElementById('cv-compact-hint');
  function setCompactMode(on: boolean): void {
    if (on && collapsed) setCollapsed(false);
    compactMode = on;
    userPanel?.classList.toggle('compact', on);
    compactBtn?.classList.toggle('active', on);
    if (compactHintEl) compactHintEl.textContent = on ? 'double-click to expand' : 'double-click to compact';
    // Let the panel resize to fit its new content on mode switch. Without this
    // the inline height set at startup (or by a previous resize) keeps the
    // frame at the compact size when expanding — cramming headers and sections
    // inside. Width is preserved (user's horizontal size preference).
    if (userPanel) userPanel.style.height = '';
    savePrefs({ compactMode: on });
    if (on) updateCompactMoves();
  }

  if (collapsed) setCollapsed(true);

  collapseBtn?.addEventListener('click', () => { collapsed = !collapsed; setCollapsed(collapsed); });

  function updateCompactMoves(): void {
    if (!compactMovesEl) return;
    const result = state.currentResult;
    if (!result?.evaluation?.top_moves?.length) {
      compactMovesEl.innerHTML = '';
      return;
    }
    const fen = result.evaluation.fen;
    let html = '';
    for (let i = 0; i < result.evaluation.top_moves.length; i++) {
      const move = result.evaluation.top_moves[i];
      if (move.loss_cp > state.lossThreshold) continue;
      const uci = move.pv[0];
      // Convert to SAN via core
      const sanArr = fen ? uciToSan(fen, [uci]) : [uci];
      const label = sanArr[0] || uci;
      const cls = (i === state.selectedLineIndex ? ' selected' : '') + (i === userLockedLine ? ' locked' : '');
      const hex = lossToColor(move.loss_cp);
      const cr = parseInt(hex.slice(1, 3), 16);
      const cg = parseInt(hex.slice(3, 5), 16);
      const cb = parseInt(hex.slice(5, 7), 16);
      const bg = `rgba(${cr},${cg},${cb},0.25)`;
      const lossHtml = move.loss_cp < 5 ? '' : `<span class="compact-loss">−${(move.loss_cp / 100).toFixed(1)}</span>`;
      html += `<div class="compact-move${cls}" data-line="${i}" style="background:${bg}"><span class="compact-label">${label}</span>${lossHtml}</div>`;
    }
    compactMovesEl.innerHTML = html;
    compactMovesEl.querySelectorAll('.compact-move').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt((el as HTMLElement).dataset.line!, 10);
        // "This line is currently playing" uses live state, not userLockedLine
        // (userLockedLine can be reset by processPendingResult on eval-FEN change,
        // which caused the toggle to need two clicks to take effect).
        const playingThis = state.lineVisible && state.selectedLineIndex === idx;
        if (playingThis) stopPvLine();
        else triggerLine(idx);
      });
      // Fit text to container width
      const label = el.querySelector('.compact-label') as HTMLElement;
      if (label) {
        let size = 10;
        label.style.fontSize = size + 'px';
        while (label.scrollWidth > el.clientWidth && size > 5) {
          size -= 0.5;
          label.style.fontSize = size + 'px';
        }
      }
    });
  }

  // Expose for processPendingResult
  (window as any).__chessrayUpdateCompactMoves = updateCompactMoves;

  if (compactMode) setCompactMode(true);
  compactBtn?.addEventListener('click', () => setCompactMode(!compactMode));
  // Double-click panel to toggle compact mode
  userPanel?.addEventListener('dblclick', (e) => {
    // Don't toggle on double-click of interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('input, button, .compact-move')) return;
    setCompactMode(!compactMode);
  });

  // ── Reset panel position (triggered from dock menu) ──
  window.chessRay.onResetPanelPosition(() => {
    const panel = userPanel;
    if (panel) {
      panel.style.left = '20px';
      panel.style.top = '20px';
      panel.style.right = 'auto';
      savePrefs({ panelLeft: 20, panelTop: 20 });
      // Dim everything and highlight the panel
      document.querySelectorAll('.reset-dim').forEach(el => el.remove());
      const dim = document.createElement('div');
      dim.className = 'reset-dim';
      document.body.appendChild(dim);
      dim.addEventListener('animationend', () => dim.remove());
      panel.classList.remove('flash');
      void panel.offsetWidth;
      panel.classList.add('flash');
      panel.addEventListener('animationend', () => panel.classList.remove('flash'), { once: true });
    }
  });

  // ── Orientation badge click: toggle manual orientation override ──
  // First click: pin the opposite of whatever's currently detected (i.e. flip
  // the board). Second click: return to auto-detection. The override is also
  // auto-cleared in processPendingResult when the position changes enough to
  // look like a new game (FEN similarity < 0.5).
  const orientationBadge = document.getElementById('cv-orientation-badge');
  orientationBadge?.addEventListener('click', () => {
    if (state.manualOrientationFlip === null) {
      // Pin to the opposite of what we're currently rendering
      const detected = state.displayFlipped;
      state.manualOrientationFlip = !detected;
    } else {
      state.manualOrientationFlip = null;
    }
    orientationBadge.classList.toggle('manual', state.manualOrientationFlip !== null);
    savePrefs({ manualOrientationFlip: state.manualOrientationFlip });
    window.chessRay.setManualFlip(state.manualOrientationFlip);
  });
  // Reflect the initial pref on the badge.
  if (state.manualOrientationFlip !== null) {
    orientationBadge?.classList.add('manual');
  }

  // ── Window controls ──
  const closeBtn = document.getElementById('cv-close-btn');
  closeBtn?.addEventListener('click', () => window.chessRay.closeApp());

  // Hide panel: button + global hotkey toggle (Cmd/Ctrl+Shift+H, registered in main).
  // Hides only the user panel (controls); the canvas overlay arrows continue.
  const hideBtn = document.getElementById('cv-hide-btn');
  function setPanelHidden(hidden: boolean): void {
    if (!userPanel) return;
    userPanel.style.display = hidden ? 'none' : '';
  }
  hideBtn?.addEventListener('click', () => setPanelHidden(true));
  window.chessRay.onTogglePanel(() => {
    if (!userPanel) return;
    setPanelHidden(userPanel.style.display !== 'none' ? true : false);
  });

  // Reset all settings: wipe saved prefs and reload so the renderer comes back
  // up with DEFAULT_PREFS. Confirmation already happened in the main process.
  window.chessRay.onResetAllSettings(() => {
    try { localStorage.removeItem('chessray-prefs'); } catch { /* ignore */ }
    location.reload();
  });

  // Lichess analysis — toggle floating window + sync control
  const lichessBtn = document.getElementById('cv-lichess-btn');
  const lichessSyncCheckbox = document.getElementById('cv-lichess-sync') as HTMLInputElement | null;

  lichessBtn?.addEventListener('click', () => {
    const fen = state.currentResult?.evaluation?.fen ?? state.currentResult?.recognition?.fen;
    if (fen) {
      lichessOpen = !lichessOpen;
      lichessBtn.classList.toggle('active', lichessOpen);
      const color = state.displayFlipped ? 'black' : 'white';
      window.chessRay.toggleLichess(fen, color);
    }
  });

  lichessSyncCheckbox?.addEventListener('change', () => {
    lichessSync = lichessSyncCheckbox.checked;
    // If re-enabling sync, immediately update to current position
    if (lichessSync && lichessOpen) {
      const fen = state.currentResult?.evaluation?.fen ?? state.currentResult?.recognition?.fen;
      if (fen) {
        lastLichessFen = fen.split(' ')[0];
        const color = state.displayFlipped ? 'black' : 'white';
        window.chessRay.updateLichess(fen, color);
      }
    }
  });

  // ── Settings → System group (mirrors the dock menu) ──
  document.getElementById('cv-reset-panel-btn')?.addEventListener('click', () => {
    window.chessRay.requestResetPanelPosition();
  });
  document.getElementById('cv-reset-all-btn')?.addEventListener('click', () => {
    // Main shows the same Electron confirm dialog the dock-menu entry uses,
    // then sends `reset-all-settings` if the user confirms.
    window.chessRay.requestResetAllSettings();
  });

  const displaySwitcher = document.getElementById('cv-display-switcher');
  async function refreshDisplaySwitcher(): Promise<void> {
    if (!displaySwitcher) return;
    const displays = await window.chessRay.getDisplays();
    if (displays.length < 2) {
      displaySwitcher.hidden = true;
      displaySwitcher.innerHTML = '';
      return;
    }
    displaySwitcher.hidden = false;
    const activeId = displays[0]?.activeId ?? null;
    displaySwitcher.innerHTML = displays.map(d => {
      const label = `${d.primary ? 'Built-in' : 'Display'} (${d.width}\u00d7${d.height})`;
      const active = d.id === activeId ? ' active' : '';
      return `<button class="toggle-btn${active}" data-display-id="${d.id}">${label}</button>`;
    }).join('');
    displaySwitcher.querySelectorAll<HTMLButtonElement>('button[data-display-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.displayId!, 10);
        window.chessRay.switchDisplay(id);
      });
    });
  }
  void refreshDisplaySwitcher();
  window.chessRay.onDisplaysChanged(() => { void refreshDisplaySwitcher(); });
}

initOverlay();

// ── IPC listeners ──

let pendingResult: PipelineResult | null = null;
let rafScheduled = false;
/** Wall time of the previous frame's render (DOM update) — fed back into the
 *  next frame's frame_timing so the panel shows last-frame render cost. */
let lastRenderMs = 0;

let userLockedLine = -1; // -1 = cycle all, >= 0 = locked to that line
let lastEvalFen: string | null = null;
let lastRecogFen: string | null = null;
let lastEvalDepth: number = 0;

function selectLine(index: number): void {
  state.selectedLineIndex = index;
  if (state.currentResult) {
    // User explicitly picked a line — play its PV animation regardless of the
    // autoplay setting (autoplay only controls whether PVs start on their own
    // after the top-moves delay).
    (window as any).__chessrayClearAutoTimer?.();
    state.arrowsVisible = false;
    state.lineVisible = true;
    (window as any).__chessrayPvGrowStart?.();
    const snap = historyIndex !== null ? snapshotToResult(debugHistory[historyIndex]) : null;
    updateDebugPanel(state.currentResult, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, state.lossThreshold, selectLine, snap);
    renderArrows(state);
    renderVideoOverlay(state);
  }
}

/** User clicked an arrow — lock to that line and play its PV animation.
 *  Mirrors the compact-pill click path so both entry points behave identically. */
function triggerLine(index: number): void {
  userLockedLine = index;
  state.hoveredArrowIndex = null;
  selectLine(index);
  (window as any).__chessrayUpdateCompactMoves?.();
}

/** User clicked the animated board (or compact pill while a line is playing) —
 *  stop playback and restore the arrow view. */
function stopPvLine(): void {
  userLockedLine = -1;
  state.hoveredArrowIndex = null;
  (window as any).__chessrayPvPlayStop?.();
  state.arrowsVisible = true;
  state.lineVisible = false;
  renderArrows(state);
  renderVideoOverlay(state);
  (window as any).__chessrayUpdateCompactMoves?.();
}

function processPendingResult(): void {
  rafScheduled = false;
  const result = pendingResult;
  if (!result) return;
  pendingResult = null;
  const tRender = Date.now();

  // No board detected — clear everything
  if (!result.board_detection?.found) {
    state.currentResult = null;
    state.currentArrows = [];
    lastEvalFen = null;
    (window as any).__chessrayPvPlayStop?.();
    renderArrows(state);
    clearVideoOverlay(state);
    clearDebugPanel(debugImg, debugFen, debugInfo);
    return;
  }

  state.displayFlipped = !!result.flipped;
  state.currentResult = result;

  // Stop playback immediately when recognition FEN changes (before eval arrives)
  const recogFen = result.recognition?.fen ?? null;
  if (recogFen && recogFen !== lastRecogFen) {
    // Manual orientation override auto-resets when the new position is too
    // dissimilar to look like the same game (new game detected).
    if (state.manualOrientationFlip !== null && lastRecogFen) {
      const similarity = fenSimilarity(lastRecogFen, recogFen);
      if (similarity < 0.5) {
        state.manualOrientationFlip = null;
        savePrefs({ manualOrientationFlip: null });
        window.chessRay.setManualFlip(null);
        document.getElementById('cv-orientation-badge')?.classList.remove('manual');
      }
    }
    lastRecogFen = recogFen;
    (window as any).__chessrayPvPlayStop?.();
    // Snap old PV arrows away so they don't fade out over the new position
    resetVideoArrowAnimation();

    // Hold moves if showMovesDelay is configured
    if (showMovesDelaySec > 0) {
      movesHeld = true;
      if (movesHeldTimer !== null) clearTimeout(movesHeldTimer);
      movesHeldTimer = setTimeout(() => {
        movesHeldTimer = null;
        movesHeld = false;
        // Position is stable — apply arrows from latest state and trigger normal flow
        const r = state.currentResult;
        state.currentArrows = r?.arrows?.length ? r.arrows : [];
        renderArrows(state);
        renderVideoOverlay(state);
        (window as any).__chessrayResetAutoTimer?.();
        if (state.lineVisible) (window as any).__chessrayPvGrowStart?.();
      }, showMovesDelaySec * 1000);
    }
  }

  // Reset to best line when position changes
  const evalFen = result.evaluation?.fen ?? null;
  const evalDepth = result.eval_depth ?? 0;
  if (evalFen && evalFen !== lastEvalFen) {
    state.selectedLineIndex = 0;
    userLockedLine = -1;
    lastEvalFen = evalFen;
    lastEvalDepth = evalDepth;
    if (!movesHeld) {
      (window as any).__chessrayResetAutoTimer?.();
      // If line is already visible (non-auto mode), restart grow from 2
      if (state.lineVisible) (window as any).__chessrayPvGrowStart?.();
    }
  } else if (evalDepth >= lastEvalDepth) {
    // Same position, same or deeper eval — continue grow if displayed moves still match
    lastEvalDepth = evalDepth;
    if (!movesHeld && state.lineVisible) (window as any).__chessrayPvGrowContinue?.();
  }

  const snap = historyIndex !== null ? snapshotToResult(debugHistory[historyIndex]) : null;
  updateDebugPanel(result, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, state.lossThreshold, selectLine, snap);
  (window as any).__chessrayUpdateCompactMoves?.();
  state.currentArrows = movesHeld ? [] : (result.arrows?.length > 0 ? result.arrows : []);
  renderArrows(state);
  renderVideoOverlay(state);

  // Auto-update Lichess window when position changes (if sync enabled).
  // Compare position-only part of FEN to avoid reloading on eval depth changes
  // or recognition→eval FEN format transitions.
  if (lichessOpen && lichessSync) {
    const fen = result.evaluation?.fen ?? result.recognition?.fen;
    const positionOnly = fen?.split(' ')[0];
    if (fen && positionOnly && positionOnly !== lastLichessFen) {
      lastLichessFen = positionOnly;
      const color = state.displayFlipped ? 'black' : 'white';
      window.chessRay.updateLichess(fen, color);
    }
  }

  lastRenderMs = Date.now() - tRender;
}

window.chessRay.onFrameResult((result) => {
  const r = result as PipelineResult;
  if (r.frame_timing) {
    const sent = r.frame_timing.sent_at;
    if (typeof sent === 'number') r.frame_timing.ipc_ms = Math.max(0, Date.now() - sent);
    // Carry over the previous frame's render cost so the panel always shows the
    // latest measurable values (current frame's render_ms isn't known until
    // after the DOM update completes).
    r.frame_timing.render_ms = lastRenderMs;
  }
  // Slow-frame capture: end-to-end > FPS budget → snapshot to persisted history.
  // Skip when no frame_timing (e.g. board-not-found early return) and when no
  // image — those snapshots wouldn't be useful to inspect later.
  if (r.frame_timing && r.board_image_url && fpsBudgetMs > 0) {
    const total = frameTotalMs(r);
    if (total > fpsBudgetMs) {
      debugHistory = pushSlowFrame(debugHistory, r, total, fpsBudgetMs);
      // Stay on Live by default — user opts into history via the nav buttons.
      refreshHistoryNav(document.getElementById('cv-debug-history-nav'));
    }
  }
  // Auto-tune the FPS within the user-set range based on this frame's outcome.
  tickFpsController(r);
  pendingResult = r;
  if (!rafScheduled) {
    rafScheduled = true;
    // setTimeout instead of rAF: transparent overlays can have rAF stalled
    // by the OS when the window isn't considered active on launch
    setTimeout(processPendingResult, 0);
  }
});

window.chessRay.onDisplayInfo((info) => {
  state.displayInfo = info;
});

window.chessRay.onSourceVisibility((visible) => {
  state.sourceVisible = visible;
  if (!visible) {
    clearVideoOverlay(state);
  } else if (state.currentResult) {
    renderVideoOverlay(state);
  }
});

window.chessRay.onStopTracking(() => {
  state.currentArrows = [];
  state.currentResult = null;
  (window as any).__chessrayClearAutoTimer?.();
  (window as any).__chessrayPvGrowStop?.();
  (window as any).__chessrayPvPlayStop?.();
  renderArrows(state);
  clearVideoOverlay(state);
});
