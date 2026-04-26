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

  // ── Debug surface — mirrors debug-panel.ts output ──────────────────
  function levelForSection(ms) {
    if (ms < 25) return 'fast';
    if (ms < 75) return 'ok';
    if (ms < 200) return 'mid';
    if (ms < 400) return 'slow';
    return 'over';
  }
  function levelForTotal(ms) {
    if (ms < 100) return 'fast';
    if (ms < 250) return 'ok';
    if (ms < 400) return 'mid';
    if (ms < 500) return 'slow';
    return 'over';
  }

  function renderHistoryNav(state) {
    if (!state || state.count === 0) return '';
    const inHistory = state.index !== null;
    const liveActive = !inHistory ? ' active' : '';
    const idxText = inHistory ? `${state.index + 1}/${state.count}` : `${state.count}/${state.count}`;
    const meta = inHistory && state.totalMs != null
      ? `<span class="meta">${state.totalMs}ms${state.ageLabel ? ` · ${state.ageLabel}` : ''}</span>`
      : `<span class="meta">${state.ageLabel ?? ''}</span>`;
    return `<div class="r2-hist">
      <button${inHistory && state.index === 0 ? ' disabled' : ''}>◀</button>
      <span class="idx">${idxText}</span>
      <button${inHistory && state.index === state.count - 1 ? ' disabled' : ''}>▶</button>
      <button class="${liveActive.trim()}">Live</button>
      ${meta}
      <button>Clear</button>
    </div>`;
  }

  function renderFrameTiming(ft) {
    const total = ft.total;
    const totalLevel = levelForTotal(total);
    const slowBadge = ft.slow ? `<span class="ft-cache-badge" style="color:var(--ft-slow);border-color:var(--ft-slow)">⚠ slow</span>` : '';
    const cacheBadge = ft.cached
      ? `<span class="ft-cache-badge ft-cache-cached">cached</span>`
      : `<span class="ft-cache-badge ft-cache-fresh">fresh</span>`;
    const fpsBadge = ft.activeFps > 0 ? `<span class="ft-fps-badge">${ft.activeFps} fps</span>` : '';
    const conf = (window.CHESSRAY_MOCK.recognition?.confidence != null)
      ? `${(window.CHESSRAY_MOCK.recognition.confidence * 100).toFixed(0)}%` : '—';
    const evalText = ft.eval ? `eval d${ft.eval.depth} · ${ft.eval.ms}ms` : '';

    const stackBudget = Math.max(total, 1);
    const stackHtml = ft.stages
      .filter(s => s.ms > 0)
      .map(s => {
        const pct = (s.ms / stackBudget) * 100;
        const lvl = levelForSection(s.ms);
        return `<div class="ft-seg ft-${lvl}" style="flex:0 0 ${pct.toFixed(2)}%" title="${s.label}: ${s.ms}ms"></div>`;
      }).join('');

    const maxRowMs = Math.max(1, ...ft.stages.map(s => s.ms));
    const rowsHtml = ft.stages.map(s => {
      const lvl = levelForSection(s.ms);
      const pct = (s.ms / maxRowMs) * 100;
      const dim = s.dim ? ' ft-row-dim' : '';
      return `<div class="ft-row${dim}">`
        + `<span class="ft-label">${s.label}</span>`
        + `<span class="ft-rowbar"><span class="ft-rowbar-fill ft-${lvl}" style="width:${pct.toFixed(2)}%"></span></span>`
        + `<span class="ft-ms ft-ms-${lvl}">${s.ms}ms</span>`
        + `</div>`;
    }).join('');

    return `<div class="ft-total ft-${totalLevel}">
      <span class="ft-total-label">frame</span>
      <span class="ft-total-ms">${total}ms</span>
      ${cacheBadge}${slowBadge}
      <span class="ft-meta">
        ${fpsBadge}${fpsBadge ? ' · ' : ''}<span>conf ${conf}</span>
        ${evalText ? ` · <span class="ft-eval">${evalText}</span>` : ''}
      </span>
    </div>
    <div class="ft-stack">${stackHtml}</div>
    <div class="ft-rows">${rowsHtml}</div>`;
  }

  function rgbSwatch(rgb) {
    return `<span class="sw" style="background:rgb(${rgb.join(',')})"></span>`;
  }

  function renderHighlightDebug(d) {
    if (!d) return '';
    const flags = [];
    if (d.flags?.midAnimation)      flags.push(`<span class="hl-anno">mid-animation</span>`);
    if (d.flags?.invalidHighlights) flags.push(`<span class="hl-rejected">invalid (no legal pair)</span>`);
    const flagsLine = flags.length ? `<div class="hl-row">${flags.join(' ')}</div>` : '';

    const mediansLine = `<div class="hl-row">
      <span class="hl-k">medians</span>
      ${rgbSwatch(d.medians.light)} light
      ${rgbSwatch(d.medians.dark)} dark
    </div>`;

    const candHtml = d.candidates.length
      ? d.candidates.map(c =>
          `<span class="hl-cand">${c.square}<span class="hl-score">${c.score.toFixed(0)}</span><span class="hl-glyph">${c.piece ?? '·'}</span></span>`
        ).join(' ')
      : '<span style="color:var(--text-faint)">none</span>';
    const candsLine = `<div class="hl-row">
      <span class="hl-k">candidates (${d.candidates.length})</span> ${candHtml}
    </div>`;

    const sorted = [...d.pairs].sort((a, b) => b.score - a.score);
    const pairHtml = sorted.map(p => {
      const tag = p.winner ? ' winner' : '';
      const natTag = p.natural ? '<span class="hl-natural">natural</span>' : '<span class="hl-anno">annotation</span>';
      return `<div class="hl-pair${tag}">
        <span class="hl-pair-move">${p.src}→${p.dest}</span>
        <span class="hl-pair-piece">${p.piece}</span>
        <span class="hl-pair-score">score ${p.score.toFixed(0)}</span>
        <span class="hl-pair-pass">p${p.pass}</span>
        ${natTag}
      </div>`;
    }).join('');
    const rejTag = d.rejectedCount > 0 ? `<span class="hl-rejected">+${d.rejectedCount} rejected (illegal move)</span>` : '';
    const pairsHeader = `<div class="hl-row"><span class="hl-k">legal pairs (${d.pairs.length})</span> ${rejTag}</div>`;
    const pairsBlock = `${pairsHeader}<div class="hl-pairs">${pairHtml}</div>`;

    const winnerLine = d.winner
      ? `<div class="hl-row hl-winner"><span class="hl-k">winner</span> <b>${d.winner.src}→${d.winner.dest}</b> — ${d.winner.reasonLabel}</div>`
      : '';

    return `<div class="hl-block">${flagsLine}${candsLine}${mediansLine}${pairsBlock}${winnerLine}</div>`;
  }

  window.renderDebug = function (sel) {
    const root = document.querySelector(sel);
    root.classList.add('r2-debug-body');
    root.innerHTML = `
      ${renderHistoryNav(M.history)}

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

      <div class="r2-knob">
        <label>Img size</label>
        <input type="range" min="25" max="200" value="100">
        <span class="v">100<small>%</small></span>
      </div>

      <div class="r2-fen">${M.fen}</div>
      <div class="r2-orient">${M.orientation.side} · ${M.orientation.source}</div>

      ${M.detectionStatus ? `<div class="r2-status">${M.detectionStatus}</div>` : ''}

      ${renderFrameTiming(M.frameTiming)}

      ${renderHighlightDebug(M.highlightDebug)}

      <div class="r2-debug-actions">
        <button class="r2-toolbtn">Box</button>
        <button class="r2-toolbtn">Copy</button>
        <button class="r2-toolbtn">● Record</button>
      </div>
    `;
  };
})();
