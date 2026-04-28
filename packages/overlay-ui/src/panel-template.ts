// Panel HTML — injected into the document by mountOverlay() so each host's
// entry HTML can stay minimal. The video-overlay canvas is included so the
// host doesn't have to author it; cv-* element IDs match the lookups in
// debug-panel.ts / canvas-renderer.ts / mount-overlay.ts.

export const PANEL_HTML = `\
<canvas id="video-overlay"></canvas>

<div class="panel user-panel" id="user-panel">
  <!-- Single-row header: status dot · tabs · diagnostics · window controls. -->
  <div class="r2-head r2-head-merged" id="cv-main-toggles">
    <span class="r2-head-dot turn-dot white" id="cv-app-dot" data-tip="ChessRay is running. Color reflects whose turn it is to move." data-tip-pos="below"></span>
    <div class="r2-tabs" id="r2-tabs">
      <button class="r2-tab active" id="r2-tab-moves" data-view="moves">Analysis</button>
      <button class="r2-tab" id="r2-tab-settings" data-view="settings">Settings</button>
    </div>
    <span class="r2-spacer"></span>
    <button class="r2-tab r2-tab-diag" id="r2-tab-debug" data-view="debug" data-tip="Diagnostics" data-tip-pos="below">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="6" height="8" rx="3"/><path d="M2 6h2M2 9h2M2 12h2M12 6h2M12 9h2M12 12h2M8 2v3M5 4l-1-1M11 4l1-1"/></svg>
    </button>
    <button class="r2-btn" id="cv-hide-btn" data-tip="Hide control panel (toggle: Cmd/Ctrl+Shift+H)" data-tip-pos="below">&#x2014;</button>
    <button class="r2-btn danger" id="cv-close-btn" data-tip="Close" data-tip-pos="below">&#xD7;</button>
  </div>

  <div class="panel-body" id="cv-panel-body">
    <!-- Moves view (default) -->
    <div class="r2-view r2-view-moves" id="r2-view-moves">
      <div class="r2-board-block">
        <div class="board-fit" id="cv-board-fit">
          <div class="board-container">
            <div class="piece-grid" id="cv-debug-grid"></div>
            <canvas id="cv-arrow-canvas" width="200" height="200"></canvas>
          </div>
        </div>
        <div class="eval-bar">
          <div class="eval-bar-fill" id="cv-eval-fill" style="width:50%"></div>
          <div class="eval-bar-label" id="cv-eval-label"></div>
        </div>
      </div>
      <div class="r2-status-bar" id="cv-status-bar" role="heading" aria-level="2">
        <span class="r2-status-cell" id="cv-status-turn" data-tip="Whose turn it is to move." data-tip-pos="below">
          <span class="r2-status-dot turn-dot"></span><span class="r2-status-text">—</span>
        </span>
        <span class="r2-status-cell r2-status-orient" id="cv-status-orient" data-tip="Detected board orientation. Click to override; click again to return to auto-detection." data-tip-pos="below">
          <span class="r2-status-text">—</span><span class="r2-status-suffix">auto</span>
        </span>
        <span class="r2-status-cell" id="cv-status-depth" data-tip="Engine search depth completed for the current position." data-tip-pos="below">
          <span class="r2-status-text">Depth —</span>
        </span>
        <span class="r2-status-cell" id="cv-status-lines" data-tip="Number of engine lines the next deeper pass will compute (the multi-PV count from Settings → Engine → Lines)." data-tip-pos="below">
          <span class="r2-status-text">— lines</span>
        </span>
        <span class="r2-status-cell" id="cv-status-fps" data-tip="Frame capture rate the auto-tuner is currently targeting. Adjusts within [1, FPS max] based on observed pipeline cost." data-tip-pos="below">
          <span class="r2-status-text">— fps</span>
        </span>
      </div>
      <div class="r2-moves" id="cv-best-moves"></div>
    </div>

    <!-- Settings view -->
    <div class="r2-view" id="r2-view-settings" hidden>
      <div class="r2-surface-body">

        <div class="r2-group">
          <div class="r2-group-label">Engine</div>
          <div class="pv-depth-row">
            <label data-tip="Number of engine lines shown. The first (quick) eval uses up to 3; every deeper eval uses this value.">Lines analyzed</label>
            <input type="range" id="cv-multi-pv-max" min="1" max="8" value="5" step="1">
            <span id="cv-multi-pv-max-val">5</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Upper bound of the auto-tuned frame capture rate. The system can climb to this ceiling when fresh (non-cached) frames stay well under budget; floor is 1 fps.">Capture rate (max)</label>
            <input type="range" id="cv-fps-max" min="1" max="5" value="5" step="1">
            <span id="cv-fps-max-val">5</span><span class="pv-unit">fps</span>
          </div>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Animation</div>
          <div class="pv-depth-row" id="cv-pv-depth-row">
            <label data-tip="Number of moves to play through in the best-line piece animation. At max the slider reads 'All' — show the full principal variation.">Preview move count</label>
            <input type="range" id="cv-pv-depth" min="1" max="11" value="11">
            <span id="cv-pv-depth-val">All</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Seconds between each move in the best-line piece-by-piece animation.">Step interval</label>
            <input type="range" id="cv-pv-grow-delay" min="1" max="10" value="1" step="1">
            <span id="cv-pv-grow-delay-val">1</span><span class="pv-unit">s</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Seconds the preview phase stays visible (selected move highlighted, others hidden) before the per-step PV piece animation begins.">Preview hold</label>
            <input type="range" id="cv-pv-preview-sec" min="0" max="5" value="1" step="1">
            <span id="cv-pv-preview-sec-val">1</span><span class="pv-unit">s</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Maximum centipawn loss for showing alternative moves. Lower = only near-best moves; higher = more options visualized.">Alt-move threshold (cp)</label>
            <input type="range" id="cv-loss-threshold" min="0" max="500" value="100" step="10">
            <span id="cv-loss-threshold-val">100</span>
          </div>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Overlay</div>
          <div class="pv-depth-row">
            <label data-tip="Size of all on-board decorations: arrows, PV move numbers, and played-move markers.">Marker size</label>
            <input type="range" id="cv-overlay-size" min="3" max="10" value="5" step="1">
            <span id="cv-overlay-size-val">5</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Opacity of all on-board decorations: arrows, PV move numbers, and played-move markers. Color still carries quality.">Marker opacity</label>
            <input type="range" id="cv-overlay-opacity" min="20" max="100" value="50" step="5">
            <span id="cv-overlay-opacity-val">50</span><span class="pv-unit">%</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Eval bar opacity on the actual-board overlay while the eval is stale (position changed, engine is catching up). Higher = easier to follow; lower = more subtle.">Stale eval-bar opacity</label>
            <input type="range" id="cv-eval-stale-opacity" min="30" max="100" value="90" step="5">
            <span id="cv-eval-stale-opacity-val">90</span><span class="pv-unit">%</span>
          </div>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Show on screen</div>
          <label class="display-toggle" data-tip="On-screen markers drawn directly over the detected board: best-move arrows, PV step labels, and played-move markers."><input type="checkbox" id="cv-disp-overlay" checked><span>Live-board markers</span></label>
          <label class="display-toggle" data-tip="Vertical evaluation bar drawn next to the detected board on screen."><input type="checkbox" id="cv-disp-eval" checked><span>Eval bar</span></label>
          <label class="display-toggle" data-tip="Mini chessboard inside the control panel that mirrors the recognized position and animates the best line."><input type="checkbox" id="cv-disp-vboard" checked><span>Mini board (panel)</span></label>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Tools</div>
          <div class="lichess-controls">
            <button class="toggle-btn" id="cv-lichess-btn" data-tip="Open the current position in a floating Lichess analysis board.">&#9816; Open in Lichess analysis</button>
            <label class="lichess-sync-label" data-tip="Keep the Lichess analysis board in sync with the live recognized position as it changes."><input type="checkbox" id="cv-lichess-sync" checked><span>Mirror current position</span></label>
          </div>
        </div>

        <div class="r2-group" id="cv-system-group">
          <div class="r2-group-label">System</div>
          <div class="r2-system-actions">
            <button class="toggle-btn" id="cv-reset-panel-btn" data-tip="Move the panel back to the top-right corner of the screen and reset its size.">Move panel to default position</button>
            <button class="toggle-btn" id="cv-reset-all-btn" data-tip="Wipe every saved preference and reload the panel with defaults. Display capture choice is preserved.">Restore default settings…</button>
          </div>
          <div class="r2-display-switcher" id="cv-display-switcher" hidden></div>
        </div>

      </div>
    </div>

    <!-- Debug view -->
    <div class="r2-view" id="r2-view-debug" hidden>
      <div class="r2-surface-body debug-section" id="debug-section">
        <div class="debug-history-nav" id="cv-debug-history-nav" style="display:none"></div>
        <div class="debug-img-wrap" id="cv-debug-img-wrap">
          <img id="cv-debug-img" src="" alt="Board capture" data-tip="JPEG preview of the cropped board pixels actually fed into the recognition pipeline. Useful for verifying the bbox is on the board and not on adjacent UI." data-tip-pos="below">
        </div>
        <div class="pv-depth-row">
          <label data-tip="Resize the board preview image (percent of panel width). Doesn't affect detection — preview only.">Preview size</label>
          <input type="range" id="cv-debug-img-scale" min="25" max="200" value="100" step="5">
          <span id="cv-debug-img-scale-val">100</span><span class="pv-unit">%</span>
        </div>
        <div class="fen" id="cv-debug-fen" data-tip="Full FEN of the recognized position (with side to move, castling rights, en passant, halfmove clock and fullmove number) once eval has run; otherwise position-only.">Waiting...</div>
        <div class="debug-orient" id="cv-orientation-info" data-tip="Detected board orientation (white at top vs bottom) and the signal that decided it: coord labels (OCR), pawn move direction, or piece-count heuristic."></div>
        <div class="meta" id="cv-debug-info"></div>
        <div class="detection-status" id="cv-detection-status" style="display:none" data-tip="Why the latest frame wasn't fully processed (e.g. mid-animation, low confidence, no highlights, intermediate frame)."></div>
        <div class="highlight-debug" id="cv-highlight-debug"></div>
        <div class="toggle-row">
          <button class="toggle" id="cv-border-btn" data-tip="Draw a green rectangle around the detected board on the actual screen. Useful for verifying the bbox visually.">Show board box</button>
          <button class="toggle" id="cv-copy-debug-btn" data-tip="Copy all debug details for the current view (live frame or selected history entry) to the clipboard as Markdown + JSON.">Copy diagnostics</button>
          <button class="toggle" id="cv-record-btn" data-tip="Dump raw captured frames to ~/chessray-recordings/ for test fixtures.">● Record frames</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Hidden — kept so legacy handlers (top-toggle clicks driven by Show-on-screen
       checkboxes) still find their target elements without throwing. -->
  <div class="r2-legacy-hidden" hidden>
    <button id="cv-overlay-btn"></button>
    <button id="cv-vboard-btn"></button>
    <button id="cv-eval-btn"></button>
    <button id="cv-compact-btn"></button>
    <button id="cv-collapse-btn"></button>
    <span id="cv-compact-hint"></span>
    <div id="cv-compact-moves"></div>
  </div>

  <div class="resize-grip bottom-right" id="cv-resize-grip-br"></div>
  <div class="resize-grip bottom-left" id="cv-resize-grip-bl"></div>
  <div class="resize-grip top-right" id="cv-resize-grip-tr"></div>
  <div class="resize-grip top-left" id="cv-resize-grip-tl"></div>
</div>
`;
