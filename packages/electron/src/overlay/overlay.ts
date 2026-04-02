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

let debugPanel: HTMLDivElement | null = null;
let debugImg: HTMLImageElement | null = null;
let debugFen: HTMLDivElement | null = null;
let debugInfo: HTMLDivElement | null = null;
let isTracking = false;

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
  debugPanel = document.getElementById('debug-panel') as HTMLDivElement;
  debugImg = document.getElementById('cv-debug-img') as HTMLImageElement;
  debugFen = document.getElementById('cv-debug-fen') as HTMLDivElement;
  debugInfo = document.getElementById('cv-debug-info') as HTMLDivElement;
  state.canvas = document.getElementById('cv-arrow-canvas') as HTMLCanvasElement;

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
  if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';

  // Global overlay toggle
  const overlayBtn = document.getElementById('cv-overlay-btn');
  if (overlayBtn) {
    overlayBtn.classList.toggle('active', state.overlayVisible);
    overlayBtn.addEventListener('click', () => {
      state.overlayVisible = !state.overlayVisible;
      if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';
      overlayBtn.classList.toggle('active', state.overlayVisible);
      document.querySelectorAll('.vis-btn').forEach(btn => {
        (btn as HTMLButtonElement).disabled = !state.overlayVisible;
      });
      savePrefs({ overlayVisible: state.overlayVisible });
    });
  }

  // Per-element visibility toggles
  const borderBtn = document.getElementById('cv-border-btn');
  if (borderBtn) {
    borderBtn.classList.toggle('active', state.borderVisible);
    borderBtn.addEventListener('click', () => {
      state.borderVisible = !state.borderVisible;
      borderBtn.classList.toggle('active', state.borderVisible);
      savePrefs({ borderVisible: state.borderVisible });
    });
  }

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

initOverlay();

// ── IPC listeners ──

let pendingResult: PipelineResult | null = null;
let rafScheduled = false;

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

  updateDebugPanel(result, state.displayFlipped, debugPanel, debugImg, debugFen, debugInfo);
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
