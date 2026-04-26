// Shared render helpers for v2 playground variants. Static — no real state.
(function () {
  const M = window.CHESSRAY_MOCK;

  window.renderMoves = function (sel) {
    const root = document.querySelector(sel);
    root.innerHTML = '';
    M.lines.forEach((ln, i) => {
      const cls = ['r2-row'];
      if (i === 0) cls.push('selected');
      if (ln.cp >= 0) cls.push('pos'); else cls.push('neg');
      const row = document.createElement('div');
      row.className = cls.join(' ');
      row.innerHTML = `
        <span class="rank">${ln.rank}</span>
        <span class="san">${ln.san}<em>${ln.full.split(' ').slice(1, 4).join(' ')}</em></span>
        <span class="score">${ln.score}</span>
        <span class="playing">on board</span>
      `;
      row.addEventListener('click', () => {
        root.querySelectorAll('.r2-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
      });
      root.appendChild(row);
    });
  };

  window.renderSettings = function (sel) {
    const root = document.querySelector(sel);
    root.innerHTML = `
      <div class="r2-group">
        <div class="r2-group-label">Engine</div>
        <div class="r2-knob"><label>Depth</label><input type="range" min="8" max="40" step="4" value="28"><span class="v">28</span></div>
        <div class="r2-knob"><label>Lines</label><input type="range" min="1" max="8" value="5"><span class="v">5</span></div>
        <div class="r2-knob"><label>FPS max</label><input type="range" min="1" max="5" value="5"><span class="v">5</span></div>
        <div class="r2-knob"><label>Change-detect</label><input type="checkbox" checked><span class="v">on</span></div>
      </div>

      <div class="r2-group">
        <div class="r2-group-label">Animation</div>
        <div class="r2-knob"><label>PV depth</label><input type="range" min="1" max="11" value="10"><span class="v">10</span></div>
        <div class="r2-knob"><label>Grow</label><input type="range" min="1" max="10" value="3"><span class="v">3<small>s</small></span></div>
        <div class="r2-knob"><label>Preview</label><input type="range" min="0" max="5" value="1"><span class="v">1<small>s</small></span></div>
        <div class="r2-knob"><label>Wait</label><input type="range" min="0" max="10" value="0"><span class="v">0<small>s</small></span></div>
        <div class="r2-knob"><label>Autoplay</label><input type="checkbox"><span class="v">off</span></div>
        <div class="r2-knob"><label>Auto delay</label><input type="range" min="1" max="15" value="5"><span class="v">5<small>s</small></span></div>
        <div class="r2-knob"><label>CP loss</label><input type="range" min="0" max="500" step="10" value="0"><span class="v">0</span></div>
      </div>

      <div class="r2-group">
        <div class="r2-group-label">Overlay</div>
        <div class="r2-knob"><label>Size</label><input type="range" min="3" max="10" value="5"><span class="v">5</span></div>
        <div class="r2-knob"><label>Opacity</label><input type="range" min="20" max="100" step="5" value="85"><span class="v">85<small>%</small></span></div>
        <div class="r2-knob"><label>Stale eval</label><input type="range" min="30" max="100" step="5" value="75"><span class="v">75<small>%</small></span></div>
      </div>

      <div class="r2-group">
        <div class="r2-group-label">Show on screen</div>
        <label class="r2-switch"><input type="checkbox" checked><span>Actual-board overlay</span></label>
        <label class="r2-switch"><input type="checkbox" checked><span>Eval bar</span></label>
        <label class="r2-switch"><input type="checkbox" checked><span>Virtual board</span></label>
      </div>

      <div class="r2-group">
        <div class="r2-group-label">Tools</div>
        <button class="r2-toolbtn">♞ Lichess analysis board</button>
        <label class="r2-switch" style="padding-top:8px"><input type="checkbox" checked><span>Auto-sync position</span></label>
      </div>
    `;
  };

  window.renderDebug = function (sel) {
    const root = document.querySelector(sel);
    root.innerHTML = `
      <svg class="r2-debug-img" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="bd" x="0" y="0" width="50" height="50" patternUnits="userSpaceOnUse">
            <rect width="25" height="25" fill="#f0d9b5"/>
            <rect x="25" y="25" width="25" height="25" fill="#f0d9b5"/>
            <rect x="25" width="25" height="25" fill="#b58863"/>
            <rect y="25" width="25" height="25" fill="#b58863"/>
          </pattern>
        </defs>
        <rect width="200" height="200" fill="url(#bd)"/>
        <rect x="0" y="0" width="200" height="200" fill="none" stroke="#22c55e" stroke-width="2"/>
        <text x="6" y="14" font-size="9" fill="#22c55e" font-family="monospace">192×192 · bbox</text>
      </svg>
      <div class="r2-knob" style="margin-top:8px">
        <label>Img size</label>
        <input type="range" min="25" max="200" value="100">
        <span class="v">100<small>%</small></span>
      </div>
      <div class="r2-fen">${M.fen}</div>
      <dl class="r2-kv">
        <dt>Orientation</dt><dd>white at bottom · OCR</dd>
        <dt>Confidence</dt><dd>0.94</dd>
        <dt>Highlights</dt><dd>e2 → e4</dd>
        <dt>Frame</dt><dd>17ms · 312KB</dd>
        <dt>Eval cache</dt><dd>hit (cached d24)</dd>
      </dl>
      <div class="r2-debug-actions">
        <button class="r2-toolbtn">Box</button>
        <button class="r2-toolbtn">Copy</button>
        <button class="r2-toolbtn">● Record</button>
      </div>
    `;
  };
})();
