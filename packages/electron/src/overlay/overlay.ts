/**
 * Overlay renderer — transparent always-on-top window that draws arrows and debug panel.
 * Port of content/overlay.ts adapted for Electron (no Shadow DOM, screen coords).
 */

import type { PipelineResult } from '@chessray/core';
import { applyUciMoves, uciToSan, lossToColor } from '@chessray/core';
import { loadPrefs, savePrefs } from './preferences.js';
import { type OverlayState, renderArrows, renderVideoOverlay, clearVideoOverlay, drawArrow } from './canvas-renderer.js';
import { setupDrag, updateDebugPanel, clearDebugPanel, renderBoardGrid } from './debug-panel.js';
import { pieceSvg } from './piece-svg.js';

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
      setChangeDetect: (enabled: boolean) => void;
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
  vboardOverlayVisible: true,
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
      panelScale = Math.min(4, Math.max(0.5, panelScale + delta));
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
      const newScale = Math.min(4, Math.max(0.5, startScale + scaleDelta));

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
    panelScale = Math.min(4, Math.max(0.5, scale));
    applyScale(); updateZoomUI(); savePrefs({ panelScale });
  }

  document.getElementById('cv-zoom-in')?.addEventListener('click', () => setZoom(panelScale + 0.1));
  document.getElementById('cv-zoom-out')?.addEventListener('click', () => setZoom(panelScale - 0.1));
  zoomSlider?.addEventListener('input', () => setZoom(parseInt(zoomSlider.value, 10) / 100));

  // Restore visual state from prefs
  if (state.videoCanvas) state.videoCanvas.style.display = state.overlayVisible ? '' : 'none';
  if (state.canvas) state.canvas.style.display = state.overlayVisible ? '' : 'none';

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

  // Actual board overlay toggle
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
        (window as any).__chessrayResetAutoTimer?.();
        if (state.lineVisible) pvCycleStart();
      } else {
        (window as any).__chessrayClearAutoTimer?.();
        // Stop cycle if both overlays are hidden
        if (!state.vboardOverlayVisible) pvCycleStop();
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
      savePrefs({ vboardOverlayVisible: state.vboardOverlayVisible });
      if (state.vboardOverlayVisible) {
        // Redraw virtual board arrows if cycle is running
        renderArrows(state);
        if (state.lineVisible && !pvCycleTimer) pvCycleStart();
      } else {
        // Clean up virtual board visuals
        document.querySelectorAll('.piece-anim').forEach(el => el.remove());
        if (state.canvas) {
          const ctx = state.canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        }
        // Stop animation and restore board to original state
        if ((window as any).__chessrayPvPlaying) {
          pvCycleStop();
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
      // Reset grow on mode change
      if (state.lineVisible) { pvCycleStart(); } else { pvCycleStop(); }
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

  // ── Unified PV line cycle ──
  // In line mode, the actual board and virtual board animate in sync:
  // - Actual board: arrows grow one by one (1, 2, 3... up to pvDepth)
  // - Virtual board: shows position after N moves with arrow+highlight for move N
  // When the sequence completes, both reset and loop.
  const pvGrowSlider = document.getElementById('cv-pv-grow-delay') as HTMLInputElement | null;
  const pvGrowVal = document.getElementById('cv-pv-grow-delay-val');
  let pvGrowDelaySec = prefs.pvGrowDelaySec;
  let pvCycleTimer: ReturnType<typeof setInterval> | null = null;
  let pvCycleLastPv: string[] = [];
  let pvCycleBaseFen = '';
  let pvCycleFlipped = false;
  let pvCyclePv: string[] = [];

  let pvCycleMovesTimer: ReturnType<typeof setTimeout> | null = null;
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
      // Locked: repeat same line
      pvCycleLineIndex = userLockedLine;
    } else {
      // Advance to next line in the cycle
      const curPos = indices.indexOf(pvCycleLineIndex);
      const nextPos = (curPos + 1) % indices.length;
      pvCycleLineIndex = indices[nextPos];
    }
    state.selectedLineIndex = pvCycleLineIndex;

    // Exit analysis view for the interlude
    (window as any).__chessrayPvPlaying = false;
    document.getElementById('cv-debug-grid')?.classList.remove('analysis');
    document.querySelectorAll('.piece-anim').forEach(el => el.remove());

    // Show moves briefly between lines
    pvCycleArrowsWas = state.arrowsVisible;
    state.arrowsVisible = true;
    state.lineVisible = false;
    syncModeButtons();
    renderArrows(state);
    renderVideoOverlay(state);
    updateCompactMoves();

    pvCycleMovesTimer = setTimeout(() => {
      pvCycleMovesTimer = null;
      state.arrowsVisible = pvCycleArrowsWas;
      state.lineVisible = true;
      syncModeButtons();
      pvCycleStartCurrentLine();
    }, autoDelaySec * 1000);
  }

  function pvCycleStep(): void {
    if (state.pvDisplayDepth >= state.pvDepth || state.pvDisplayDepth >= pvCyclePv.length) {
      // Sequence complete
      if (pvCycleTimer !== null) { clearInterval(pvCycleTimer); pvCycleTimer = null; }
      state.pvDisplayDepth = 0;

      // Reset virtual board if visible
      if (state.vboardOverlayVisible) {
        const grid = document.getElementById('cv-debug-grid');
        if (grid) renderBoardGrid(grid, pvCycleBaseFen.split(' ')[0], pvCycleFlipped, []);
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

    // Update actual board overlay (shows arrows 1..step)
    renderVideoOverlay(state);

    // Skip virtual board animation if vboard overlay is hidden
    if (!state.vboardOverlayVisible) return;

    // Animate piece movement on virtual board
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

    const grid = document.getElementById('cv-debug-grid');
    const container = grid?.parentElement;
    if (!grid || !container) { pvCycleStop(); return; }

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

    // Render board BEFORE the move with source square emptied (piece "picked up")
    // and highlight on source square
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
    renderBoardGrid(grid, pickedUpFen, pvCycleFlipped, [fromIdx, toIdx]);

    // Compute pixel positions for source and destination squares
    const sq = 25; // grid square size in CSS px
    let srcFile = fromFile, srcRank = fromRank, dstFile = toFileN, dstRank = toRankN;
    if (pvCycleFlipped) {
      srcFile = 7 - srcFile; srcRank = 7 - srcRank;
      dstFile = 7 - dstFile; dstRank = 7 - dstRank;
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
        renderBoardGrid(grid, afterPos.fen, pvCycleFlipped, afterPos.highlight);
      }
    }, { once: true });
    // Fallback if transitionend doesn't fire
    setTimeout(() => {
      if (floater.parentElement) {
        floater.remove();
        if ((window as any).__chessrayPvPlaying) {
          renderBoardGrid(grid, afterPos.fen, pvCycleFlipped, afterPos.highlight);
        }
      }
    }, 500);

    // Draw single arrow for the current move on virtual board canvas
    if (state.canvas) {
      const size = 200;
      const dpr = window.devicePixelRatio || 1;
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

      // Build a single arrow for the current move
      const turn = pvCycleBaseFen.split(' ')[1] || 'w';
      const isWhite = (step % 2 === 1) === (turn === 'w');
      const arrow = {
        from: fromSq, to: toSq,
        color: isWhite ? '#e5e5e5' : '#1a1a1a',
        width: 3, opacity: 0.8, loss_cp: 0,
        label: String(step),
      };
      drawArrow(ctx, arrow, { x: 0, y: 0, width: size, height: size }, 1, state.displayFlipped);
    }
  }

  /** Start animating the current pvCycleLineIndex */
  function pvCycleStartCurrentLine(): void {
    if (pvCycleTimer !== null) { clearInterval(pvCycleTimer); pvCycleTimer = null; }
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
    (window as any).__chessrayPvPlaying = true;
    document.getElementById('cv-debug-grid')?.classList.add('analysis');

    // First step immediately
    pvCycleStep();
    // Then continue on interval
    pvCycleTimer = setInterval(pvCycleStep, pvGrowDelaySec * 1000);
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
    const displayedMatch = state.pvDisplayDepth <= newPv.length &&
      pvCycleLastPv.slice(0, state.pvDisplayDepth).every((m, i) => m === newPv[i]);
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
    if (pvCycleMovesTimer !== null) {
      clearTimeout(pvCycleMovesTimer); pvCycleMovesTimer = null;
      // Restore arrows state if stopped during interlude
      state.arrowsVisible = pvCycleArrowsWas;
    }
    const wasPlaying = (window as any).__chessrayPvPlaying;
    (window as any).__chessrayPvPlaying = false;
    const grid = document.getElementById('cv-debug-grid');
    grid?.classList.remove('analysis');
    document.querySelectorAll('.piece-anim').forEach(el => el.remove());
    // Restore board grid to base position (before animation moved pieces)
    if (wasPlaying && pvCycleBaseFen && grid) {
      renderBoardGrid(grid, pvCycleBaseFen.split(' ')[0], pvCycleFlipped, []);
    }
    if (wasPlaying) {
      state.pvDisplayDepth = state.pvDepth; // restore full depth
      renderArrows(state);
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
    if (!state.autoMode || !state.overlayVisible) return;

    // Show top moves immediately
    state.arrowsVisible = true;
    state.lineVisible = false;
    pvCycleStop();
    syncModeButtons();
    renderArrows(state);
    renderVideoOverlay(state);

    // Switch to line after delay (hide moves)
    autoTimer = setTimeout(() => {
      autoTimer = null;
      state.arrowsVisible = false;
      state.lineVisible = true;
      pvCycleStart();
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
  // Set correct initial visual state for auto mode (arrows first)
  if (state.autoMode) {
    state.arrowsVisible = true;
    syncModeButtons();
  }
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
      pvCycleStop();
    }
    savePrefs({ autoMode: state.autoMode });
  });


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

  function setCompactMode(on: boolean): void {
    if (on && collapsed) setCollapsed(false);
    compactMode = on;
    userPanel?.classList.toggle('compact', on);
    compactBtn?.classList.toggle('active', on);
    if (compactMovesEl) compactMovesEl.classList.toggle('hidden', !on);
    savePrefs({ compactMode: on });
    if (on) updateCompactMoves();
  }

  if (collapsed) setCollapsed(true);

  collapseBtn?.addEventListener('click', () => { collapsed = !collapsed; setCollapsed(collapsed); });

  function updateCompactMoves(): void {
    if (!compactMode || !compactMovesEl) return;
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
      const scoreStr = move.score_cp >= 0 ? `+${(move.score_cp / 100).toFixed(1)}` : (move.score_cp / 100).toFixed(1);
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
        // Toggle lock: click same = unlock, click different = lock
        if (userLockedLine === idx) {
          userLockedLine = -1;
          updateCompactMoves();
        } else {
          userLockedLine = idx;
          selectLine(idx);
          updateCompactMoves();
        }
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
  // Double-click board to toggle compact mode
  document.getElementById('cv-debug-grid')?.addEventListener('dblclick', () => {
    setCompactMode(!compactMode);
  });

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
let userLockedLine = -1; // -1 = cycle all, >= 0 = locked to that line
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
    userLockedLine = -1;
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
  (window as any).__chessrayUpdateCompactMoves?.();
  state.currentArrows = result.arrows?.length > 0 ? result.arrows : [];
  renderArrows(state);
  renderVideoOverlay(state);
}

window.chessRay.onFrameResult((result) => {
  pendingResult = result as PipelineResult;
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
