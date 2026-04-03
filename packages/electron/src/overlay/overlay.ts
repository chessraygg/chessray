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
let useSan: boolean;

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
  useSan = prefs.useSan;

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
  function applyScale(): void {
    if (!userPanel) return;
    userPanel.style.transform = `scale(${panelScale})`;
    userPanel.style.transformOrigin = 'top right';
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

  // ── Resize grip (drag to scale) ──
  const resizeGrip = document.getElementById('cv-resize-grip');
  if (resizeGrip && userPanel) {
    let resizing = false;
    let startY = 0;
    let startScale = 1;

    resizeGrip.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation();
      resizing = true;
      startY = e.clientY;
      startScale = panelScale;
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!resizing) return;
      const dy = e.clientY - startY;
      // ~200px drag = 1x scale change
      panelScale = Math.min(2, Math.max(0.5, startScale + dy / 200));
      applyScale();
    });

    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        savePrefs({ panelScale });
      }
    });
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
    notationBtn.textContent = useSan ? 'SAN' : 'UCI';
    notationBtn.classList.toggle('active', useSan);
    notationBtn.addEventListener('click', () => {
      useSan = !useSan;
      notationBtn.textContent = useSan ? 'SAN' : 'UCI';
      notationBtn.classList.toggle('active', useSan);
      savePrefs({ useSan });
      // Re-render current result with new notation
      if (state.currentResult) {
        updateDebugPanel(state.currentResult, state.displayFlipped, debugImg, debugFen, debugInfo, useSan, state.selectedLineIndex, state.lineVisible, selectLine);
      }
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
