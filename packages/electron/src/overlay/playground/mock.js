// Mock chess data shared across playground variants.
// Position: a middlegame from a real game (Carlsen-Niemann-style imbalance).

export const POSITION = {
  fen: 'r2q1rk1/pp2bppp/2n1pn2/3p4/3P4/2NBPN2/PP3PPP/R1BQ1RK1',
  turn: 'w',
  orientation: 'white',
  highlights: ['e7', 'd5'], // last move
};

// 8x8 ASCII board derived from FEN above
export const BOARD = [
  ['r','.','.','q','.','r','k','.'],
  ['p','p','.','.','b','p','p','p'],
  ['.','.','n','.','p','n','.','.'],
  ['.','.','.','p','.','.','.','.'],
  ['.','.','.','P','.','.','.','.'],
  ['.','.','N','B','P','N','.','.'],
  ['P','P','.','.','.','P','P','P'],
  ['R','.','B','Q','.','R','K','.'],
];

export const PIECE_GLYPH = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

export const EVAL = {
  cp: 32,
  text: '+0.32',
  depth: 24,
  multipv: 4,
  fillPct: 56, // white-favored
};

export const LINES = [
  { rank: 0, score: '+0.32', loss: 0,    moves: 'Nxd5 exd5 Bxh7+ Kxh7 Ng5+ Kg8 Qh5 Re8' },
  { rank: 1, score: '+0.18', loss: -14,  moves: 'a3 a6 b4 Bd6 Bb2 Re8 Rc1 Bb8' },
  { rank: 2, score: '−0.04', loss: -36,  moves: 'Bg5 h6 Bxf6 Bxf6 e4 dxe4 Nxe4 Bd7' },
  { rank: 3, score: '−0.27', loss: -59,  moves: 'h3 Re8 Re1 Bf8 a3 a6' },
];

export function renderBoard(targetEl) {
  targetEl.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = document.createElement('div');
      const isLight = (r + c) % 2 === 0;
      sq.className = 'sq ' + (isLight ? 'l' : 'd');
      const file = 'abcdefgh'[c];
      const rank = 8 - r;
      const algebraic = file + rank;
      if (POSITION.highlights.includes(algebraic)) sq.classList.add('hl');
      const piece = BOARD[r][c];
      if (piece !== '.') {
        const span = document.createElement('span');
        span.className = 'pc ' + (piece === piece.toUpperCase() ? 'w' : 'b');
        span.textContent = PIECE_GLYPH[piece];
        sq.appendChild(span);
      }
      targetEl.appendChild(sq);
    }
  }
}

export function renderLines(targetEl, limit = 4) {
  targetEl.innerHTML = '';
  LINES.slice(0, limit).forEach((line) => {
    const el = document.createElement('div');
    el.className = 'line ' + (line.rank === 0 ? 'best' : line.rank === 1 ? 'alt-1' : 'alt-2');
    el.innerHTML = `
      <span class="score">${line.score}</span>
      <span class="moves">${line.moves}</span>
      <span class="loss">${line.loss === 0 ? '' : line.loss + 'cp'}</span>
    `;
    targetEl.appendChild(el);
  });
}

export function attachMenuToggle(buttonId, menuId) {
  const btn = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu.open').forEach((m) => { if (m !== menu) m.classList.remove('open'); });
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) menu.classList.remove('open');
  });
}

export function setupTabs(containerSelector) {
  document.querySelectorAll(containerSelector).forEach((container) => {
    const tabs = container.querySelectorAll('.tab');
    const panes = container.querySelectorAll('[data-tab-pane]');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const id = tab.dataset.tab;
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        panes.forEach((p) => p.style.display = p.dataset.tabPane === id ? '' : 'none');
      });
    });
  });
}

// Bind each range slider's value to the .val span next to it (within the same .row).
// Preserves trailing units like "s" if already present.
export function bindSliders() {
  document.querySelectorAll('.row input[type=range]').forEach((input) => {
    const val = input.parentElement.querySelector('.val');
    if (!val) return;
    const original = (val.textContent || '').trim();
    const unit = /[a-zA-Z]+$/.exec(original)?.[0] ?? '';
    const sync = () => { val.textContent = input.value + unit; };
    input.addEventListener('input', sync);
    sync();
  });
}
