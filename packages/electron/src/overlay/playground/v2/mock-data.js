// Static sample data for v2 playground variants. No state, no logic.
// Mirrors the shape rendered by debug-panel.ts so the mock looks faithful.
window.CHESSRAY_MOCK = {
  turn: 'b',
  depth: 24,
  multipv: 5,
  fps: 3.2,
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
  orientation: { side: 'white bottom', source: 'coord labels' },
  recognition: { confidence: 0.94 },

  lines: [
    { rank: 1, san: 'Nf3',  full: 'Nf3 Nc6 d4 exd4 Nxd4 Nf6', score:  '+0.42', cp:  42 },
    { rank: 2, san: 'e4',   full: 'e4 e5 Nf3 Nc6 Bb5 a6',     score:  '+0.31', cp:  31 },
    { rank: 3, san: 'c4',   full: 'c4 c5 Nc3 Nc6 g3 g6',      score:  '+0.25', cp:  25 },
    { rank: 4, san: 'd4',   full: 'd4 d5 c4 e6 Nc3 Nf6',      score:  '+0.18', cp:  18 },
    { rank: 5, san: 'g3',   full: 'g3 d5 Bg2 Nf6 Nf3 c6',     score: '-0.05',  cp:  -5 },
  ],

  // Slow-frame history nav state (matches DebugHistoryNavState)
  history: { count: 4, index: null, ageLabel: 'live' },

  detectionStatus: null, // e.g. "mid-animation — frame skipped" when set

  // Frame timing — same shape as the live FrameTiming object surfaced in
  // debug-panel.ts / renderFrameTiming.
  frameTiming: {
    total: 187,
    budgetMs: 333,             // 3 fps budget
    activeFps: 3,
    cached: false,
    slow: false,
    eval: { depth: 24, ms: 412 },
    stages: [
      { key: 'capture',     label: 'capture',       ms: 12 },
      { key: 'fingerprint', label: 'fingerprint',   ms:  4 },
      { key: 'detect-skip', label: 'detect (skip)', ms:  1, dim: true },
      { key: 'crop',        label: 'crop',          ms:  3 },
      { key: 'preview',     label: 'preview',       ms:  6 },
      { key: 'changedet',   label: 'change det',    ms:  8 },
      { key: 'yolo-prep',   label: 'yolo prep',     ms: 11 },
      { key: 'yolo-infer',  label: 'yolo infer',    ms: 78 },
      { key: 'yolo-post',   label: 'yolo post',     ms:  9 },
      { key: 'pieces',      label: 'pieces',        ms:  4 },
      { key: 'orient',      label: 'orientation',   ms: 22 },
      { key: 'highlights',  label: 'highlights',    ms:  7 },
      { key: 'disamb',      label: 'disambiguate',  ms:  2 },
      { key: 'turn',        label: 'turn',          ms:  1 },
      { key: 'fenbuild',    label: 'fen build',     ms:  1 },
      { key: 'gameover',    label: 'game over',     ms:  3 },
      { key: 'seqmove',     label: 'seq move',      ms:  2 },
      { key: 'ipc',         label: 'ipc',           ms:  6 },
      { key: 'render',      label: 'render (prev)', ms:  7 },
    ],
  },

  // Highlight detection breakdown — matches the live HighlightDebug shape.
  highlightDebug: {
    medians: { light: [232, 217, 181], dark: [181, 136,  99] },
    flags:   { midAnimation: false, invalidHighlights: false },
    candidates: [
      { square: 'e2', score: 142.4, piece: '·' },
      { square: 'e4', score: 129.7, piece: 'P' },
      { square: 'd4', score:  18.3, piece: '·' },
    ],
    pairs: [
      { src: 'e2', dest: 'e4', piece: 'P', score: 272.1, pass: 1, natural: true,  winner: true  },
      { src: 'd2', dest: 'd4', piece: 'P', score:  56.4, pass: 2, natural: false, winner: false },
    ],
    rejectedCount: 1,
    winner: { src: 'e2', dest: 'e4', reasonLabel: 'top score among legal pairs in initial candidates' },
  },
};
