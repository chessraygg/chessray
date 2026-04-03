/**
 * Overlay renderer — transparent always-on-top window that draws arrows and debug panel.
 * Port of content/overlay.ts adapted for Electron (no Shadow DOM, screen coords).
 */

import type { PipelineResult } from '@chessray/core';
import { loadPrefs, savePrefs } from './preferences.js';
import { type OverlayState, renderArrows, renderVideoOverlay, clearVideoOverlay } from './canvas-renderer.js';
import { setupDrag, setTrackingState, updateDebugPanel } from './debug-panel.js';

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
let isTracking = false;
let useSan = true;

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

  // Update arrow canvas to match new board size (200x200)
  if (state.canvas) {
    state.canvas.width = 200;
    state.canvas.height = 200;
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

  // Make user panel draggable by controls row (expanded) and toggle row (collapsed)
  const controlsRow = userPanel?.querySelector('.controls-row') as HTMLElement | null;
  const toggleRow = document.getElementById('cv-main-toggles') as HTMLElement | null;
  if (controlsRow && userPanel) setupDrag(controlsRow, userPanel);
  if (toggleRow && userPanel) setupDrag(toggleRow, userPanel);

  // Restore panel position
  if (userPanel && prefs.panelLeft != null && prefs.panelTop != null) {
    userPanel.style.left = `${prefs.panelLeft}px`;
    userPanel.style.top = `${prefs.panelTop}px`;
    userPanel.style.right = 'auto';
  }

  // Restore visual state from prefs
  if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';

  // ── Inline debug section toggle ──
  const debugToggle = document.getElementById('cv-debug-toggle');
  const debugSection = document.getElementById('debug-section');
  if (debugToggle && debugSection) {
    debugToggle.addEventListener('click', () => {
      const isHidden = debugSection.classList.toggle('hidden');
      debugToggle.classList.toggle('active', !isHidden);
      debugToggle.innerHTML = isHidden ? 'Debug &#x25B8;' : 'Debug &#x25BE;';
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

  const evalBtn = document.getElementById('cv-eval-btn');
  if (evalBtn) {
    evalBtn.classList.toggle('active', state.evalBarVisible);
    evalBtn.addEventListener('click', () => {
      state.evalBarVisible = !state.evalBarVisible;
      evalBtn.classList.toggle('active', state.evalBarVisible);
      savePrefs({ evalBarVisible: state.evalBarVisible });
    });
  }

  // ── SAN/UCI notation toggle ──
  const notationBtn = document.getElementById('cv-notation-btn');
  if (notationBtn) {
    notationBtn.classList.toggle('active', useSan);
    notationBtn.addEventListener('click', () => {
      useSan = !useSan;
      notationBtn.textContent = useSan ? 'SAN' : 'UCI';
      notationBtn.classList.toggle('active', useSan);
      // Re-render current result with new notation
      if (state.currentResult) {
        updateDebugPanel(state.currentResult, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, selectLine);
      }
    });
  }

  // ── Collapse panel ──
  const collapseBtn = document.getElementById('cv-collapse-btn');
  const collapseBtnInline = document.getElementById('cv-collapse-btn-inline');
  const panelBody = document.getElementById('cv-panel-body');

  function setCollapsed(c: boolean): void {
    panelBody?.classList.toggle('hidden', c);
    userPanel?.classList.toggle('collapsed', c);
    collapseBtn?.classList.toggle('collapsed', c);
    collapseBtnInline?.classList.toggle('collapsed', c);
    savePrefs({ collapsed: c });
  }

  let collapsed = prefs.collapsed;
  if (collapsed) setCollapsed(true);

  collapseBtn?.addEventListener('click', () => { collapsed = !collapsed; setCollapsed(collapsed); });
  collapseBtnInline?.addEventListener('click', () => { collapsed = !collapsed; setCollapsed(collapsed); });

  // ── Window controls ──
  const closeBtn = document.getElementById('cv-close-btn');
  const closeBtnInline = document.getElementById('cv-close-btn-inline');
  const closeApp = () => window.chessRay.closeApp();
  closeBtn?.addEventListener('click', closeApp);
  closeBtnInline?.addEventListener('click', closeApp);
}

initOverlay();

// ── IPC listeners ──

let pendingResult: PipelineResult | null = null;
let rafScheduled = false;
let lastEvalFen: string | null = null;

function selectLine(index: number): void {
  state.selectedLineIndex = index;
  if (state.currentResult) {
    updateDebugPanel(state.currentResult, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, selectLine);
    renderArrows(state);
    renderVideoOverlay(state);
  }
}

function processPendingResult(): void {
  rafScheduled = false;
  const result = pendingResult;
  if (!result) return;
  pendingResult = null;

  if (!isTracking) {
    isTracking = true;
    setTrackingState(true);
  }
  state.displayFlipped = !!result.flipped;
  state.currentResult = result;

  // Reset to best line when position changes
  const evalFen = result.evaluation?.fen ?? null;
  if (evalFen && evalFen !== lastEvalFen) {
    state.selectedLineIndex = 0;
    lastEvalFen = evalFen;
  }

  updateDebugPanel(result, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, selectLine);
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
  isTracking = false;
  setTrackingState(false);
  state.currentArrows = [];
  state.currentResult = null;
  renderArrows(state);
  clearVideoOverlay(state);
});
