// Static sample data for v2 playground variants. No state, no logic.
window.CHESSRAY_MOCK = {
  turn: 'white',           // 'white' | 'black'
  depth: 24,
  multipv: 5,
  fps: 3.2,
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
  lines: [
    { rank: 1, san: 'Nf3',  full: 'Nf3 Nc6 d4 exd4 Nxd4 Nf6', score:  '+0.42', cp:  42 },
    { rank: 2, san: 'e4',   full: 'e4 e5 Nf3 Nc6 Bb5 a6',     score:  '+0.31', cp:  31 },
    { rank: 3, san: 'c4',   full: 'c4 c5 Nc3 Nc6 g3 g6',      score:  '+0.25', cp:  25 },
    { rank: 4, san: 'd4',   full: 'd4 d5 c4 e6 Nc3 Nf6',      score:  '+0.18', cp:  18 },
    { rank: 5, san: 'g3',   full: 'g3 d5 Bg2 Nf6 Nf3 c6',     score: '-0.05',  cp:  -5 },
  ],
};
