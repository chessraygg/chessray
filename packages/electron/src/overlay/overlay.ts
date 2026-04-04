/**
 * Overlay renderer — transparent always-on-top window that draws arrows and debug panel.
 * Port of content/overlay.ts adapted for Electron (no Shadow DOM, screen coords).
 */

import type { PipelineResult } from '@chessray/core';
import { loadPrefs, savePrefs } from './preferences.js';
import { type OverlayState, renderArrows, renderVideoOverlay, clearVideoOverlay } from './canvas-renderer.js';
import { setupDrag, updateDebugPanel } from './debug-panel.js';

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
  pvDepth: 4,
  evalBarVisible: true,
  sourceVisible: true,
  selectedLineIndex: 0,
  lossThreshold: 50,
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

  if (arrowsBtn) {
    arrowsBtn.classList.toggle('active', state.arrowsVisible);
    arrowsBtn.addEventListener('click', () => {
      state.arrowsVisible = !state.arrowsVisible;
      arrowsBtn.classList.toggle('active', state.arrowsVisible);
      if (state.arrowsVisible && state.lineVisible) {
        state.lineVisible = false;
        lineBtn?.classList.toggle('active', false);
        if (pvDepthRow) pvDepthRow.style.display = 'none';
      }
      savePrefs({ arrowsVisible: state.arrowsVisible, lineVisible: state.lineVisible });
      renderArrows(state);
    });
  }

  if (lineBtn) {
    lineBtn.classList.toggle('active', state.lineVisible);
    if (pvDepthRow) pvDepthRow.style.display = state.lineVisible ? 'flex' : 'none';
    lineBtn.addEventListener('click', () => {
      state.lineVisible = !state.lineVisible;
      lineBtn.classList.toggle('active', state.lineVisible);
      if (pvDepthRow) pvDepthRow.style.display = state.lineVisible ? 'flex' : 'none';
      if (state.lineVisible && state.arrowsVisible) {
        state.arrowsVisible = false;
        arrowsBtn?.classList.toggle('active', false);
      }
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

  // ── Window controls ──
  const closeBtn = document.getElementById('cv-close-btn');
  closeBtn?.addEventListener('click', () => window.chessRay.closeApp());
}

initOverlay();

// ── IPC listeners ──

let pendingResult: PipelineResult | null = null;
let rafScheduled = false;
let lastEvalFen: string | null = null;

function selectLine(index: number): void {
  state.selectedLineIndex = index;
  if (state.currentResult) {
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

  state.displayFlipped = !!result.flipped;
  state.currentResult = result;

  // Reset to best line when position changes
  const evalFen = result.evaluation?.fen ?? null;
  if (evalFen && evalFen !== lastEvalFen) {
    state.selectedLineIndex = 0;
    lastEvalFen = evalFen;
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
  renderArrows(state);
  clearVideoOverlay(state);
});
