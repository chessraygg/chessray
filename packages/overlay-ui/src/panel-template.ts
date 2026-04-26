// Panel HTML — injected into the document by mountOverlay() so each host's
// entry HTML can stay minimal. The video-overlay canvas is included so the
// host doesn't have to author it; cv-* element IDs match the lookups in
// debug-panel.ts / canvas-renderer.ts / mount-overlay.ts.

export const PANEL_HTML = `\
<canvas id="video-overlay"></canvas>

<div class="panel user-panel" id="user-panel">
  <!-- Slim header: turn · depth · ⚙ ⚧ — × -->
  <div class="r2-head" id="cv-main-toggles">
    <span class="r2-turn-dot turn-dot" id="cv-turn-dot"></span>
    <span class="r2-meta">
      <span class="r2-meta-depth" id="cv-eval-depth" data-tip="Currently completed engine search depth. Climbs while the position is stable; resets when a new move is recognized." data-tip-pos="below"></span>
      <span class="r2-meta-lines" id="cv-active-lines" data-tip="Number of engine lines the next deeper pass will compute (the multi-PV count from Settings → Engine → Lines)." data-tip-pos="below"></span>
      <span class="r2-meta-fps" id="cv-active-fps" data-tip="Frame capture rate the auto-tuner is currently targeting. Adjusts within [1, FPS max] based on observed pipeline cost." data-tip-pos="below"></span>
      <span class="orientation-badge r2-meta-orient" id="cv-orientation-badge" data-tip="Click to flip the board manually. Click again to return to auto-detection. Resets automatically on a new game." data-tip-pos="below">
        <span class="orient-arrow" id="cv-pawn-dir"></span>
      </span>
    </span>
    <span class="r2-spacer"></span>
    <button class="r2-btn" id="r2-btn-settings" data-tip="Settings" data-tip-pos="below">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M13.4 9.5l1.4 1.1-1.4 2.4-1.7-.5a5.6 5.6 0 0 1-1.4.8l-.4 1.7H7.1l-.4-1.7a5.6 5.6 0 0 1-1.4-.8l-1.7.5-1.4-2.4 1.4-1.1a5.6 5.6 0 0 1 0-1.6L2.2 6.6 3.6 4.2l1.7.5a5.6 5.6 0 0 1 1.4-.8l.4-1.7h2.8l.4 1.7c.5.2 1 .5 1.4.8l1.7-.5 1.4 2.4-1.4 1.1c.1.5.1 1.1 0 1.6z"/></svg>
    </button>
    <button class="r2-btn" id="r2-btn-debug" data-tip="Diagnostics" data-tip-pos="below">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="6" height="8" rx="3"/><path d="M2 6h2M2 9h2M2 12h2M12 6h2M12 9h2M12 12h2M8 2v3M5 4l-1-1M11 4l1-1"/></svg>
    </button>
    <button class="r2-btn" id="cv-hide-btn" data-tip="Hide panel (toggle: Cmd/Ctrl+Shift+H)" data-tip-pos="below">&#x2014;</button>
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
      <div class="r2-moves" id="cv-best-moves"></div>
    </div>

    <!-- Settings view -->
    <div class="r2-view" id="r2-view-settings" hidden>
      <div class="r2-surface-head">
        <button class="r2-back" id="r2-back-settings" data-tip="Back to moves" data-tip-pos="below">&#x2190;</button>
        <span class="r2-surface-title">Settings</span>
      </div>
      <div class="r2-surface-body">

        <div class="r2-group">
          <div class="r2-group-label">Engine</div>
          <div class="pv-depth-row">
            <label data-tip="Number of engine lines shown. The first (quick) eval uses up to 3; every deeper eval uses this value.">Lines</label>
            <input type="range" id="cv-multi-pv-max" min="1" max="8" value="5" step="1">
            <span id="cv-multi-pv-max-val">5</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Upper bound of the auto-tuned frame capture rate. The system can climb to this ceiling when fresh (non-cached) frames stay well under budget; floor is 1 fps.">FPS max</label>
            <input type="range" id="cv-fps-max" min="1" max="5" value="5" step="1">
            <span id="cv-fps-max-val">5</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Skip recognition when board pixels haven't changed (faster but may miss subtle changes)">Change detect</label>
            <input type="checkbox" id="cv-change-detect" checked>
          </div>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Animation</div>
          <div class="pv-depth-row" id="cv-pv-depth-row">
            <label data-tip="Number of moves to play through in the best-line piece animation">PV depth</label>
            <input type="range" id="cv-pv-depth" min="1" max="11" value="10">
            <span id="cv-pv-depth-val">10</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Seconds between each move in the best-line piece animation">Grow</label>
            <input type="range" id="cv-pv-grow-delay" min="1" max="10" value="1" step="1">
            <span id="cv-pv-grow-delay-val">1</span><span class="pv-unit">s</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Seconds the preview phase stays visible (selected move highlighted, others hidden) before the per-step PV piece animation begins.">Preview</label>
            <input type="range" id="cv-pv-preview-sec" min="0" max="5" value="1" step="1">
            <span id="cv-pv-preview-sec-val">1</span><span class="pv-unit">s</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Seconds to wait after position stabilizes before showing moves (0 = instant)">Wait</label>
            <input type="range" id="cv-show-moves-delay" min="0" max="10" value="0" step="1">
            <span id="cv-show-moves-delay-val">0</span><span class="pv-unit">s</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="After showing top moves, automatically play the best line piece-by-piece on the virtual board.">PV autoplay</label>
            <input type="checkbox" id="cv-pv-autoplay">
          </div>
          <div class="pv-depth-row" id="cv-auto-delay-row">
            <label data-tip="Seconds to show top moves before switching to best line">Delay</label>
            <input type="range" id="cv-auto-delay" min="1" max="15" value="5" step="1">
            <span id="cv-auto-delay-val">5</span><span class="pv-unit">s</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Max centipawn loss for showing alternative moves">CP loss</label>
            <input type="range" id="cv-loss-threshold" min="0" max="500" value="100" step="10">
            <span id="cv-loss-threshold-val">100</span>
          </div>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Overlay</div>
          <div class="pv-depth-row">
            <label data-tip="Size of all on-board decorations: arrows, PV move numbers, and played-move markers.">Size</label>
            <input type="range" id="cv-overlay-size" min="3" max="10" value="5" step="1">
            <span id="cv-overlay-size-val">5</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Opacity of all on-board decorations: arrows, PV move numbers, and played-move markers. Color still carries quality.">Opacity</label>
            <input type="range" id="cv-overlay-opacity" min="20" max="100" value="50" step="5">
            <span id="cv-overlay-opacity-val">50</span><span class="pv-unit">%</span>
          </div>
          <div class="pv-depth-row">
            <label data-tip="Eval bar opacity on the actual-board overlay while the eval is stale (position changed, engine is catching up). Higher = easier to follow; lower = more subtle.">Stale eval</label>
            <input type="range" id="cv-eval-stale-opacity" min="30" max="100" value="90" step="5">
            <span id="cv-eval-stale-opacity-val">90</span><span class="pv-unit">%</span>
          </div>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Show on screen</div>
          <label class="display-toggle"><input type="checkbox" id="cv-disp-overlay" checked><span>Actual-board overlay</span></label>
          <label class="display-toggle"><input type="checkbox" id="cv-disp-eval" checked><span>Eval bar</span></label>
          <label class="display-toggle"><input type="checkbox" id="cv-disp-vboard" checked><span>Virtual board</span></label>
        </div>

        <div class="r2-group">
          <div class="r2-group-label">Tools</div>
          <div class="lichess-controls">
            <button class="toggle-btn" id="cv-lichess-btn" data-tip="Open floating Lichess analysis board">&#9816; Lichess analysis board</button>
            <label class="lichess-sync-label"><input type="checkbox" id="cv-lichess-sync" checked><span>Auto-sync position</span></label>
          </div>
        </div>

        <div class="r2-group" id="cv-system-group">
          <div class="r2-group-label">System</div>
          <div class="r2-system-actions">
            <button class="toggle-btn" id="cv-reset-panel-btn" data-tip="Move the panel back to the top-right corner of the screen and reset its size.">Reset panel position</button>
            <button class="toggle-btn" id="cv-reset-all-btn" data-tip="Wipe every saved preference and reload the panel with defaults. Display capture choice is preserved.">Reset all settings…</button>
          </div>
          <div class="r2-display-switcher" id="cv-display-switcher" hidden></div>
        </div>

      </div>
    </div>

    <!-- Debug view -->
    <div class="r2-view" id="r2-view-debug" hidden>
      <div class="r2-surface-head">
        <button class="r2-back" id="r2-back-debug" data-tip="Back to moves" data-tip-pos="below">&#x2190;</button>
        <span class="r2-surface-title">Diagnostics</span>
      </div>
      <div class="r2-surface-body debug-section" id="debug-section">
        <div class="debug-history-nav" id="cv-debug-history-nav" style="display:none"></div>
        <div class="debug-img-wrap" id="cv-debug-img-wrap">
          <img id="cv-debug-img" src="" alt="Board capture" data-tip="JPEG preview of the cropped board pixels actually fed into the recognition pipeline. Useful for verifying the bbox is on the board and not on adjacent UI." data-tip-pos="below">
        </div>
        <div class="pv-depth-row">
          <label data-tip="Resize the board preview image (percent of panel width). Doesn't affect detection — preview only.">Img size</label>
          <input type="range" id="cv-debug-img-scale" min="25" max="200" value="100" step="5">
          <span id="cv-debug-img-scale-val">100</span><span class="pv-unit">%</span>
        </div>
        <div class="fen" id="cv-debug-fen" data-tip="Full FEN of the recognized position (with side to move, castling rights, en passant, halfmove clock and fullmove number) once eval has run; otherwise position-only.">Waiting...</div>
        <div class="debug-orient" id="cv-orientation-info" data-tip="Detected board orientation (white at top vs bottom) and the signal that decided it: coord labels (OCR), pawn move direction, or piece-count heuristic."></div>
        <div class="meta" id="cv-debug-info"></div>
        <div class="detection-status" id="cv-detection-status" style="display:none" data-tip="Why the latest frame wasn't fully processed (e.g. mid-animation, low confidence, no highlights, intermediate frame)."></div>
        <div class="highlight-debug" id="cv-highlight-debug"></div>
        <div class="toggle-row">
          <button class="toggle" id="cv-border-btn" data-tip="Draw a green rectangle around the detected board on the actual screen. Useful for verifying the bbox visually.">Box</button>
          <button class="toggle" id="cv-copy-debug-btn" data-tip="Copy all debug details for the current view (live frame or selected history entry) to the clipboard as Markdown + JSON.">Copy</button>
          <button class="toggle" id="cv-record-btn" data-tip="Dump raw captured frames to ~/chessray-recordings/ for test fixtures">● Record</button>
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
    <span id="cv-turn-text"></span>
    <span id="cv-compact-hint"></span>
    <div id="cv-compact-moves"></div>
  </div>

  <div class="resize-grip bottom-right" id="cv-resize-grip-br"></div>
  <div class="resize-grip bottom-left" id="cv-resize-grip-bl"></div>
  <div class="resize-grip top-right" id="cv-resize-grip-tr"></div>
  <div class="resize-grip top-left" id="cv-resize-grip-tl"></div>
</div>
`;
