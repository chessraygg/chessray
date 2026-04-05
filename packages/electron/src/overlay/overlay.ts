/**
 * Overlay renderer — transparent always-on-top window that draws arrows and debug panel.
 * Port of content/overlay.ts adapted for Electron (no Shadow DOM, screen coords).
 */

import type { PipelineResult } from '@chessray/core';
import { applyUciMoves } from '@chessray/core';
import { loadPrefs, savePrefs } from './preferences.js';
import { type OverlayState, renderArrows, renderVideoOverlay, clearVideoOverlay } from './canvas-renderer.js';
import { setupDrag, updateDebugPanel, clearDebugPanel, renderBoardGrid } from './debug-panel.js';

declare global {
  interface Window {
    chessRay: {
      onFrameResult: (cb: (result: unknown) => void) => void;
      onStopTracking: (cb: () => void) => void;
      setMousePassthrough: (passthrough: boolean) => void;
      setAlwaysOnTop: (enabled: boolean) => void;
      onDisplayInfo: (cb: (info: any) => void) => void;
      onSourceVisibility: (cb: (visible: boolean) => void) => void;
      reopenPicker: () => void;
      setMaxDepth: (depth: number) => void;
      onResetPanelPosition: (cb: () => void) => void;
      minimizeApp: () => void;
      closeApp: () => void;
    };
  }
}

// ── Module-level state ──

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
  pvWhiteColor: '#60a5fa',
  pvBlackColor: '#f9a8d4',
  evalBarVisible: true,
  sourceVisible: true,
  selectedLineIndex: 0,
  lossThreshold: 50,
  autoMode: false,
  panelScale: 1,
  displayInfo: null,
};

// ── Init ──

function initOverlay(): void {
  const prefs = loadPrefs();
  state.overlayVisible = prefs.overlayVisible;
  state.borderVisible = prefs.borderVisible;
  state.arrowsVisible = prefs.arrowsVisible;
  state.lineVisible = prefs.lineVisible;
  state.pvDepth = prefs.pvDepth;
  state.evalBarVisible = prefs.evalBarVisible;

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

  // Make entire panel draggable (setupDrag skips button clicks)
  if (userPanel) setupDrag(userPanel, userPanel);

  // Restore panel position
  if (userPanel && prefs.panelLeft != null && prefs.panelTop != null) {
    userPanel.style.left = `${prefs.panelLeft}px`;
    userPanel.style.top = `${prefs.panelTop}px`;
    userPanel.style.right = 'auto';
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
      panelScale = Math.min(2, Math.max(0.5, panelScale + delta));
      applyScale();
      savePrefs({ panelScale });
    }, { passive: false });
  }

  // ── Resize grips (drag to scale) ──
  // anchorRight: adjust left so right edge stays fixed
  // anchorBottom: drag up = enlarge (invert Y), adjust top so bottom edge stays fixed
  function setupResizeGrip(gripId: string, anchorRight: boolean, anchorBottom: boolean): void {
    const grip = document.getElementById(gripId);
    if (!grip || !userPanel) return;

    let resizing = false;
    let startY = 0;
    let startScale = 1;
    let startLeft = 0;
    let startTop = 0;
    let panelWidth = 0;
    let panelHeight = 0;

    grip.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      resizing = true;
      startY = e.clientY;
      startScale = panelScale;
      startLeft = userPanel!.offsetLeft;
      startTop = userPanel!.offsetTop;
      panelWidth = userPanel!.offsetWidth;
      panelHeight = userPanel!.offsetHeight;
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!resizing) return;
      e.preventDefault();
      const dy = e.clientY - startY;
      // Top grips: drag up = enlarge (invert), bottom grips: drag down = enlarge
      const scaleDelta = anchorBottom ? -dy / 200 : dy / 200;
      const newScale = Math.min(2, Math.max(0.5, startScale + scaleDelta));

      if (anchorRight) {
        const scaledWidthDiff = panelWidth * (newScale - startScale);
        userPanel!.style.left = `${startLeft - scaledWidthDiff}px`;
        userPanel!.style.right = 'auto';
      }
      if (anchorBottom) {
        const scaledHeightDiff = panelHeight * (newScale - startScale);
        userPanel!.style.top = `${startTop - scaledHeightDiff}px`;
      }

      panelScale = newScale;
      applyScale();
    });

    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        document.body.style.userSelect = '';
        savePrefs({ panelScale, panelLeft: userPanel!.offsetLeft, panelTop: userPanel!.offsetTop });
      }
    });
  }
  setupResizeGrip('cv-resize-grip-br', false, false);   // anchor top-left
  setupResizeGrip('cv-resize-grip-bl', true, false);     // anchor top-right
  setupResizeGrip('cv-resize-grip-tr', false, true);     // anchor bottom-left
  setupResizeGrip('cv-resize-grip-tl', true, true);      // anchor bottom-right

  // ── Zoom controls ──
  const zoomLabel = document.getElementById('cv-zoom-label');
  const zoomSlider = document.getElementById('cv-zoom-slider') as HTMLInputElement | null;

  function updateZoomUI(): void {
    const pct = Math.round(panelScale * 100);
    if (zoomLabel) zoomLabel.textContent = `${pct}%`;
    if (zoomSlider) zoomSlider.value = String(pct);
  }
  updateZoomUI();

  function setZoom(scale: number): void {
    panelScale = Math.min(2, Math.max(0.5, scale));
    applyScale(); updateZoomUI(); savePrefs({ panelScale });
  }

  document.getElementById('cv-zoom-in')?.addEventListener('click', () => setZoom(panelScale + 0.1));
  document.getElementById('cv-zoom-out')?.addEventListener('click', () => setZoom(panelScale - 0.1));
  zoomSlider?.addEventListener('input', () => setZoom(parseInt(zoomSlider.value, 10) / 100));

  // Restore visual state from prefs
  if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';

  // ── Inline debug section toggle (gear icon in top bar) ──
  const debugToggle = document.getElementById('cv-debug-toggle');
  const debugSection = document.getElementById('debug-section');
  if (debugToggle && debugSection) {
    debugToggle.addEventListener('click', () => {
      const isHidden = debugSection.classList.toggle('hidden');
      debugToggle.classList.toggle('active', !isHidden);
    });
  }

  // ── Overlay/Box toggles (debug panel) ──
  const overlayBtn = document.getElementById('cv-overlay-btn');
  const childToggles = document.querySelectorAll('#cv-eval-btn, #cv-line-btn, #cv-arrows-btn');

  function updateChildToggles(): void {
    childToggles.forEach(btn => btn.classList.toggle('parent-hidden', !state.overlayVisible));
  }

  if (overlayBtn) {
    overlayBtn.classList.toggle('active', state.overlayVisible);
    updateChildToggles();
    overlayBtn.addEventListener('click', () => {
      state.overlayVisible = !state.overlayVisible;
      if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';
      overlayBtn.classList.toggle('active', state.overlayVisible);
      updateChildToggles();
      savePrefs({ overlayVisible: state.overlayVisible });
      if (state.overlayVisible) {
        // Restart auto mode + grow when overlay becomes visible again
        (window as any).__chessrayResetAutoTimer?.();
        if (state.lineVisible) (window as any).__chessrayPvGrowStart?.();
      } else {
        // Stop everything when overlay is hidden
        (window as any).__chessrayClearAutoTimer?.();
        (window as any).__chessrayPvGrowStop?.();
        (window as any).__chessrayPvPlayStop?.();
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

  // ── User panel toggles ──
  const arrowsBtn = document.getElementById('cv-arrows-btn');
  const lineBtn = document.getElementById('cv-line-btn');
  const pvDepthRow = document.getElementById('cv-pv-depth-row');
  const pvDepthSlider = document.getElementById('cv-pv-depth') as HTMLInputElement | null;
  const pvDepthVal = document.getElementById('cv-pv-depth-val');

  function syncModeButtons(): void {
    arrowsBtn?.classList.toggle('active', state.arrowsVisible);
    lineBtn?.classList.toggle('active', state.lineVisible);
    if (pvDepthRow) pvDepthRow.style.display = state.lineVisible ? 'flex' : 'none';
  }

  if (arrowsBtn) {
    arrowsBtn.classList.toggle('active', state.arrowsVisible);
    arrowsBtn.addEventListener('click', () => {
      if (state.autoMode) return;
      state.arrowsVisible = !state.arrowsVisible;
      if (state.arrowsVisible && state.lineVisible) {
        state.lineVisible = false;
        pvGrowStop();
        pvPlayStop();
      }
      syncModeButtons();
      savePrefs({ arrowsVisible: state.arrowsVisible, lineVisible: state.lineVisible });
      renderArrows(state);
    });
  }

  if (lineBtn) {
    lineBtn.classList.toggle('active', state.lineVisible);
    if (pvDepthRow) pvDepthRow.style.display = state.lineVisible ? 'flex' : 'none';
    lineBtn.addEventListener('click', () => {
      if (state.autoMode) return;
      state.lineVisible = !state.lineVisible;
      if (state.lineVisible && state.arrowsVisible) {
        state.arrowsVisible = false;
      }
      // Reset grow on mode change
      if (state.lineVisible) { pvPlayStop(); pvGrowStart(); } else { pvGrowStop(); pvPlayStop(); }
      syncModeButtons();
      savePrefs({ arrowsVisible: state.arrowsVisible, lineVisible: state.lineVisible });
      renderArrows(state);
    });
  }

  if (pvDepthSlider && pvDepthVal) {
    pvDepthSlider.value = String(state.pvDepth);
    pvDepthVal.textContent = String(state.pvDepth);
    pvDepthSlider.addEventListener('input', () => {
      state.pvDepth = parseInt(pvDepthSlider.value, 10);
      pvDepthVal.textContent = String(state.pvDepth);
      savePrefs({ pvDepth: state.pvDepth });
      renderArrows(state);
    });
  }

  // ── PV grow timer ──
  const pvGrowSlider = document.getElementById('cv-pv-grow-delay') as HTMLInputElement | null;
  const pvGrowVal = document.getElementById('cv-pv-grow-delay-val');
  let pvGrowDelaySec = prefs.pvGrowDelaySec;
  let pvGrowTimer: ReturnType<typeof setInterval> | null = null;
  let pvGrowLastPv: string[] = [];

  function pvGrowStartInterval(): void {
    if (pvGrowTimer !== null) { clearInterval(pvGrowTimer); pvGrowTimer = null; }
    if (!state.lineVisible) return;
    if (state.pvDisplayDepth >= state.pvDepth) return;
    pvGrowTimer = setInterval(() => {
      if (state.pvDisplayDepth >= state.pvDepth) { pvGrowStop(); return; }
      state.pvDisplayDepth++;
      renderArrows(state);
      renderVideoOverlay(state);
    }, pvGrowDelaySec * 1000);
  }

  /** Full restart: reset to 1 and start growing */
  function pvGrowStart(): void {
    pvGrowStop();
    state.pvDisplayDepth = Math.min(1, state.pvDepth);
    pvGrowLastPv = getCurrentPv();
    pvGrowStartInterval();
  }

  /** Continue if displayed moves match, otherwise restart */
  function pvGrowContinue(): void {
    if (!state.lineVisible) return;
    const newPv = getCurrentPv();
    // Check if the first pvDisplayDepth moves are the same
    const displayedMatch = state.pvDisplayDepth <= newPv.length &&
      pvGrowLastPv.slice(0, state.pvDisplayDepth).every((m, i) => m === newPv[i]);
    if (displayedMatch) {
      // PV changed later but displayed portion is the same — keep going
      pvGrowLastPv = newPv;
      // Restart the interval (new PV may be longer/shorter) but keep current depth
      if (pvGrowTimer !== null) { clearInterval(pvGrowTimer); pvGrowTimer = null; }
      pvGrowStartInterval();
    } else {
      // Displayed moves changed — restart from 1
      pvGrowStart();
    }
  }

  function pvGrowStop(): void {
    if (pvGrowTimer !== null) { clearInterval(pvGrowTimer); pvGrowTimer = null; }
    pvGrowLastPv = [];
    // When grow completes at max depth, start virtual board playback after a pause
    if (state.lineVisible && state.pvDisplayDepth >= state.pvDepth) {
      pvPlaySchedule();
    }
  }

  // ── PV virtual board playback ──
  let pvPlayTimer: ReturnType<typeof setInterval> | null = null;
  let pvPlayPauseTimer: ReturnType<typeof setTimeout> | null = null;
  let pvPlayStep = 0;
  let pvPlayPv: string[] = [];
  let pvPlayBaseFen = '';
  let pvPlayFlipped = false;

  function pvPlaySchedule(): void {
    pvPlayStop();
    // Snapshot the current PV
    const result = state.currentResult;
    if (!result?.evaluation?.top_moves?.length) return;
    const idx = Math.min(state.selectedLineIndex, result.evaluation.top_moves.length - 1);
    const pv = result.evaluation.top_moves[idx].pv;
    const baseFen = result.evaluation.fen;
    if (!baseFen || pv.length === 0) return;
    pvPlayPv = [...pv];
    pvPlayBaseFen = baseFen;
    pvPlayFlipped = !!result.flipped;
    pvPlayStep = 0;

    // Start after a pause equal to grow delay
    pvPlayPauseTimer = setTimeout(() => {
      pvPlayPauseTimer = null;
      (window as any).__chessrayPvPlaying = true;
      // Clear virtual board arrows when playback starts
      if (state.canvas) {
        const ctx = state.canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
      }
      pvPlayTimer = setInterval(() => {
        pvPlayStep++;
        if (pvPlayStep > pvPlayPv.length) {
          // Reset to start position and replay
          pvPlayStep = 0;
          const grid = document.getElementById('cv-debug-grid');
          if (grid) renderBoardGrid(grid, pvPlayBaseFen.split(' ')[0], pvPlayFlipped, []);
          return;
        }
        // Clear virtual board arrows as moves are executed
        if (state.canvas) {
          const ctx = state.canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        }
        const applied = applyUciMoves(pvPlayBaseFen, pvPlayPv, pvPlayStep);
        if (!applied) { pvPlayStop(); return; }
        const grid = document.getElementById('cv-debug-grid');
        if (grid) renderBoardGrid(grid, applied.fen, pvPlayFlipped, applied.highlight);
      }, pvGrowDelaySec * 1000);
    }, pvGrowDelaySec * 1000);
  }

  function pvPlayStop(): void {
    if (pvPlayPauseTimer !== null) { clearTimeout(pvPlayPauseTimer); pvPlayPauseTimer = null; }
    if (pvPlayTimer !== null) { clearInterval(pvPlayTimer); pvPlayTimer = null; }
    const wasPlaying = (window as any).__chessrayPvPlaying;
    (window as any).__chessrayPvPlaying = false;
    pvPlayStep = 0;
    // Restore virtual board to current position when stopping
    if (wasPlaying) renderArrows(state);
  }

  function getCurrentPv(): string[] {
    const result = state.currentResult;
    if (!result?.evaluation?.top_moves?.length) return [];
    const idx = Math.min(state.selectedLineIndex, result.evaluation.top_moves.length - 1);
    return result.evaluation.top_moves[idx].pv;
  }

  (window as any).__chessrayPvGrowStart = () => { pvPlayStop(); pvGrowStart(); };
  (window as any).__chessrayPvGrowContinue = pvGrowContinue;
  (window as any).__chessrayPvGrowStop = () => { pvGrowStop(); };
  (window as any).__chessrayPvPlayStop = pvPlayStop;

  if (pvGrowSlider && pvGrowVal) {
    pvGrowSlider.value = String(pvGrowDelaySec);
    pvGrowVal.textContent = String(pvGrowDelaySec);
    pvGrowSlider.addEventListener('input', () => {
      pvGrowDelaySec = parseInt(pvGrowSlider.value, 10);
      pvGrowVal.textContent = String(pvGrowDelaySec);
      savePrefs({ pvGrowDelaySec });
      pvGrowStart();
    });
  }

  // ── PV line colors ──
  const pvWhiteColorInput = document.getElementById('cv-pv-white-color') as HTMLInputElement | null;
  const pvBlackColorInput = document.getElementById('cv-pv-black-color') as HTMLInputElement | null;
  state.pvWhiteColor = prefs.pvWhiteColor;
  state.pvBlackColor = prefs.pvBlackColor;

  function colorPickerFocus() { window.chessRay.setAlwaysOnTop(false); }
  function colorPickerBlur() { window.chessRay.setAlwaysOnTop(true); }

  if (pvWhiteColorInput) {
    pvWhiteColorInput.value = state.pvWhiteColor;
    pvWhiteColorInput.addEventListener('click', colorPickerFocus);
    pvWhiteColorInput.addEventListener('blur', colorPickerBlur);
    pvWhiteColorInput.addEventListener('input', () => {
      state.pvWhiteColor = pvWhiteColorInput.value;
      savePrefs({ pvWhiteColor: state.pvWhiteColor });
      renderArrows(state);
      renderVideoOverlay(state);
    });
  }
  if (pvBlackColorInput) {
    pvBlackColorInput.value = state.pvBlackColor;
    pvBlackColorInput.addEventListener('click', colorPickerFocus);
    pvBlackColorInput.addEventListener('blur', colorPickerBlur);
    pvBlackColorInput.addEventListener('input', () => {
      state.pvBlackColor = pvBlackColorInput.value;
      savePrefs({ pvBlackColor: state.pvBlackColor });
      renderArrows(state);
      renderVideoOverlay(state);
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
      savePrefs({ evalBarVisible: state.evalBarVisible });
    });
  }

  // ── Max engine depth slider ──
  const maxDepthSlider = document.getElementById('cv-max-depth') as HTMLInputElement | null;
  const maxDepthVal = document.getElementById('cv-max-depth-val');
  const savedMaxDepth = prefs.maxDepth;
  if (maxDepthSlider && maxDepthVal) {
    maxDepthSlider.value = String(savedMaxDepth);
    maxDepthVal.textContent = String(savedMaxDepth);
    window.chessRay.setMaxDepth(savedMaxDepth);
    maxDepthSlider.addEventListener('input', () => {
      const depth = parseInt(maxDepthSlider.value, 10);
      maxDepthVal.textContent = String(depth);
      savePrefs({ maxDepth: depth });
      window.chessRay.setMaxDepth(depth);
    });
  }

  // ── Auto mode ──
  const autoBtn = document.getElementById('cv-auto-btn');
  const autoDelayRow = document.getElementById('cv-auto-delay-row');
  const autoDelaySlider = document.getElementById('cv-auto-delay') as HTMLInputElement | null;
  const autoDelayVal = document.getElementById('cv-auto-delay-val');

  state.autoMode = prefs.autoMode;
  let autoDelaySec = prefs.autoDelaySec;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;

  function resetAutoTimer(): void {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
    if (!state.autoMode) return;

    // Show top moves immediately
    state.arrowsVisible = true;
    state.lineVisible = false;
    syncModeButtons();
    renderArrows(state);
    renderVideoOverlay(state);

    // Switch to best line after delay
    pvGrowStop(); // stop any existing grow while showing moves
    autoTimer = setTimeout(() => {
      autoTimer = null;
      state.arrowsVisible = false;
      state.lineVisible = true;
      pvGrowStart(); // start growing from 2 when line becomes visible
      syncModeButtons();
      renderArrows(state);
      renderVideoOverlay(state);
    }, autoDelaySec * 1000);
  }

  // Expose resetAutoTimer for processPendingResult
  (window as any).__chessrayResetAutoTimer = resetAutoTimer;
  (window as any).__chessrayClearAutoTimer = () => {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
  };

  function applyAutoMode(): void {
    autoBtn?.classList.toggle('active', state.autoMode);
    arrowsBtn?.classList.toggle('auto-disabled', state.autoMode);
    lineBtn?.classList.toggle('auto-disabled', state.autoMode);
    if (autoDelayRow) autoDelayRow.style.display = state.autoMode ? 'flex' : 'none';
  }

  applyAutoMode();
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

  autoBtn?.addEventListener('click', () => {
    state.autoMode = !state.autoMode;
    applyAutoMode();
    if (state.autoMode) {
      resetAutoTimer();
    } else {
      if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
      pvGrowStop();
      pvPlayStop();
    }
    savePrefs({ autoMode: state.autoMode });
  });

  // ── Collapse panel ──
  const collapseBtn = document.getElementById('cv-collapse-btn');
  const panelBody = document.getElementById('cv-panel-body');

  function setCollapsed(c: boolean): void {
    panelBody?.classList.toggle('hidden', c);
    userPanel?.classList.toggle('collapsed', c);
    collapseBtn?.classList.toggle('collapsed', c);
    savePrefs({ collapsed: c });
  }

  let collapsed = prefs.collapsed;
  if (collapsed) setCollapsed(true);

  collapseBtn?.addEventListener('click', () => { collapsed = !collapsed; setCollapsed(collapsed); });

  // ── Reset panel position (triggered from dock menu) ──
  window.chessRay.onResetPanelPosition(() => {
    if (userPanel) {
      userPanel.style.left = '20px';
      userPanel.style.top = '20px';
      userPanel.style.right = 'auto';
      savePrefs({ panelLeft: 20, panelTop: 20 });
      // Dim everything and highlight the panel
      document.querySelectorAll('.reset-dim').forEach(el => el.remove());
      const dim = document.createElement('div');
      dim.className = 'reset-dim';
      document.body.appendChild(dim);
      dim.addEventListener('animationend', () => dim.remove());
      userPanel.classList.remove('flash');
      void userPanel.offsetWidth;
      userPanel.classList.add('flash');
      userPanel.addEventListener('animationend', () => userPanel.classList.remove('flash'), { once: true });
    }
  });

  // ── Window controls ──
  const closeBtn = document.getElementById('cv-close-btn');
  closeBtn?.addEventListener('click', () => window.chessRay.closeApp());
}

initOverlay();

// ── IPC listeners ──

let pendingResult: PipelineResult | null = null;
let rafScheduled = false;
let lastEvalFen: string | null = null;
let lastRecogFen: string | null = null;
let lastEvalDepth: number = 0;

function selectLine(index: number): void {
  state.selectedLineIndex = index;
  if (state.currentResult) {
    // Restart grow from 2 when a different line is selected
    if (state.lineVisible) (window as any).__chessrayPvGrowStart?.();
    updateDebugPanel(state.currentResult, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, state.lossThreshold, selectLine);
    renderArrows(state);
    renderVideoOverlay(state);
  }
}

function processPendingResult(): void {
  rafScheduled = false;
  const result = pendingResult;
  if (!result) return;
  pendingResult = null;

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
    lastRecogFen = recogFen;
    (window as any).__chessrayPvPlayStop?.();
  }

  // Reset to best line when position changes
  const evalFen = result.evaluation?.fen ?? null;
  const evalDepth = result.eval_depth ?? 0;
  if (evalFen && evalFen !== lastEvalFen) {
    state.selectedLineIndex = 0;
    lastEvalFen = evalFen;
    lastEvalDepth = evalDepth;
    (window as any).__chessrayResetAutoTimer?.();
    // If line is already visible (non-auto mode), restart grow from 2
    if (state.lineVisible) (window as any).__chessrayPvGrowStart?.();
  } else if (evalDepth > lastEvalDepth) {
    // Same position, deeper eval — continue grow if displayed moves match
    lastEvalDepth = evalDepth;
    if (state.lineVisible) (window as any).__chessrayPvGrowContinue?.();
  }

  // Update arrows tooltip with actual multiPV count from engine
  if (result.evaluation?.top_moves?.length) {
    const n = result.evaluation.top_moves.length;
    const arrowsBtn = document.getElementById('cv-arrows-btn');
    if (arrowsBtn) arrowsBtn.setAttribute('data-tip', `Show top ${n} engine moves as arrows on board`);
  }

  updateDebugPanel(result, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, state.lossThreshold, selectLine);
  state.currentArrows = result.arrows?.length > 0 ? result.arrows : [];
  renderArrows(state);
  renderVideoOverlay(state);
}

window.chessRay.onFrameResult((result) => {
  pendingResult = result as PipelineResult;
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(processPendingResult);
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
