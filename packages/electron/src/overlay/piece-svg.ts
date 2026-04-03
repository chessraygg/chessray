// Inline SVG chess pieces (cburnett-style) for overlay rendering.
// Each piece uses viewBox="0 0 45 45" matching the standard chess piece canvas.

const whiteFill = '#fff';
const blackFill = '#333';
const stroke = '#000';
const strokeWidth = '1.5';

function wrap(paths: string, fill: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45">` +
    `<g fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ` +
    `stroke-linecap="round" stroke-linejoin="round">` +
    paths +
    `</g></svg>`
  );
}

// ---------------------------------------------------------------------------
// Path data for each piece type.  Derived from the standard cburnett set
// (public-domain Wikipedia chess pieces) — simplified for inline use while
// preserving recognisable silhouettes and proportions.
// ---------------------------------------------------------------------------

const kingPaths = [
  // Cross
  `<path d="M 22.5 11.63 L 22.5 6" style="fill:none;stroke-linecap:butt"/>`,
  `<path d="M 20 8 L 25 8" style="fill:none;stroke-linecap:butt"/>`,
  // Body
  `<path d="M 22.5 25 C 22.5 25 27 17.5 25.5 14.5 C 25.5 14.5 24.5 12 22.5 12 C 20.5 12 19.5 14.5 19.5 14.5 C 18 17.5 22.5 25 22.5 25"/>`,
  // Robe / base curves
  `<path d="M 12.5 37 C 18 40.5 27 40.5 32.5 37 L 32.5 30 C 32.5 30 41.5 25.5 38.5 19.5 C 34.5 13 25 16 22.5 23.5 L 22.5 27 L 22.5 23.5 C 20 16 10.5 13 6.5 19.5 C 3.5 25.5 12.5 30 12.5 30 L 12.5 37"/>`,
  // Base line
  `<path d="M 12.5 30 C 18 27 27 27 32.5 30" style="fill:none"/>`,
  `<path d="M 12.5 33.5 C 18 30.5 27 30.5 32.5 33.5" style="fill:none"/>`,
  `<path d="M 12.5 37 C 18 34 27 34 32.5 37" style="fill:none"/>`,
];

const queenPaths = [
  // Crown tips (circles)
  `<circle cx="6" cy="12" r="2.75"/>`,
  `<circle cx="14" cy="9" r="2.75"/>`,
  `<circle cx="22.5" cy="8" r="2.75"/>`,
  `<circle cx="31" cy="9" r="2.75"/>`,
  `<circle cx="39" cy="12" r="2.75"/>`,
  // Body
  `<path d="M 9 26 C 17.5 24.5 30 24.5 36 26 L 38.5 13.5 L 31 25 L 30.7 10.9 L 25.5 24.5 L 22.5 10 L 19.5 24.5 L 14.3 10.9 L 14 25 L 6.5 13.5 L 9 26 Z"/>`,
  // Base
  `<path d="M 9 26 C 9 28 10.5 29.5 15.5 29 C 20.5 28.5 24.5 28.5 29.5 29 C 34.5 29.5 36 28 36 26 C 27.5 24.5 17.5 24.5 9 26 Z"/>`,
  `<path d="M 11 38.5 C 18 40.5 27 40.5 34 38.5 L 34 35 C 27 36.5 18 36.5 11 35 L 11 38.5 Z"/>`,
  `<path d="M 11 29 C 18 31 27 31 34 29" style="fill:none"/>`,
  `<path d="M 12.5 31.5 L 32.5 31.5" style="fill:none"/>`,
  `<path d="M 11.5 34 C 18 35.5 27 35.5 33.5 34" style="fill:none"/>`,
];

const rookPaths = [
  // Crenellations
  `<path d="M 9 39 L 36 39 L 36 36 L 9 36 L 9 39 Z"/>`,
  `<path d="M 12.5 32 L 14 29.5 L 31 29.5 L 32.5 32 L 12.5 32 Z"/>`,
  `<path d="M 12 36 L 12 32 L 33 32 L 33 36 L 12 36 Z"/>`,
  // Body
  `<path d="M 14 29.5 L 14 16.5 L 31 16.5 L 31 29.5 L 14 29.5 Z"/>`,
  // Battlements
  `<path d="M 14 16.5 L 11 14 L 11 9 L 15 9 L 15 11 L 20 11 L 20 9 L 25 9 L 25 11 L 30 11 L 30 9 L 34 9 L 34 14 L 31 16.5 L 14 16.5 Z"/>`,
  // Lines
  `<path d="M 11 14 L 34 14" style="fill:none"/>`,
];

const bishopPaths = [
  // Mitre top
  `<path d="M 9 36 C 12.4 35.7 19.5 34 22.5 25 C 25.5 34 32.6 35.7 36 36 C 36 36 37.7 36.3 39 38 C 38.1 38.9 36.1 40.3 33 40.5 C 30 40.5 24.8 40 22.5 38 C 20.2 40 15 40.5 12 40.5 C 8.9 40.3 6.9 38.9 6 38 C 7.3 36.3 9 36 9 36 Z"/>`,
  `<path d="M 15 32 C 17.5 34.5 27.5 34.5 30 32 C 30.5 30.5 30 30 30 30 C 30 27.5 27.5 26 27.5 26 C 33 24.5 33.5 14.5 22.5 10.5 C 11.5 14.5 12 24.5 17.5 26 C 17.5 26 15 27.5 15 30 C 15 30 14.5 30.5 15 32 Z"/>`,
  // Cross on top
  `<path d="M 25 8 A 2.5 2.5 0 1 1 20 8 A 2.5 2.5 0 1 1 25 8 Z"/>`,
  // Sash line
  `<path d="M 17.5 26 L 27.5 26" style="fill:none"/>`,
  `<path d="M 15 30 C 17.5 32.5 27.5 32.5 30 30" style="fill:none"/>`,
  `<path d="M 22.5 15.5 L 22.5 20.5" style="fill:none;stroke-linecap:butt"/>`,
  `<path d="M 20 18 L 25 18" style="fill:none;stroke-linecap:butt"/>`,
];

const knightPaths = [
  // Main body
  `<path d="M 22 10 C 32.5 11 38.5 18 38 39 L 15 39 C 15 30 25 32.5 23 18"/>`,
  `<path d="M 24 18 C 24.4 20.9 18.5 19.4 16 20 C 13 20.4 13.2 23.9 12 24.5 C 8 27 10.5 15.5 11 14 C 13 11 16.5 10 16.5 10 C 18.5 10 19.28 11.44 22 10"/>`,
  // Eye
  `<circle cx="17" cy="16" r="1.5" style="fill:#000;stroke:none"/>`,
  // Nostril
  `<path d="M 13 19 C 13 17 15.5 15.5 15.5 15.5" style="fill:none"/>`,
];

const pawnPaths = [
  `<path d="M 22.5 9 C 20.3 9 18.5 10.8 18.5 13 C 18.5 13.9 18.8 14.7 19.2 15.4 C 16.4 17.2 14.5 20.2 14.5 23.5 C 14.5 24.6 14.7 25.6 15 26.5 C 12.5 27.9 10 30.3 10 34 C 10 36.5 17 39 22.5 39 C 28 39 35 36.5 35 34 C 35 30.3 32.5 27.9 30 26.5 C 30.3 25.6 30.5 24.6 30.5 23.5 C 30.5 20.2 28.6 17.2 25.8 15.4 C 26.2 14.7 26.5 13.9 26.5 13 C 26.5 10.8 24.7 9 22.5 9 Z"/>`,
];

// ---------------------------------------------------------------------------
// Black piece overrides — additional decorative inner lines that give black
// pieces their characteristic look (light inner detail on dark fill).
// ---------------------------------------------------------------------------

const blackKingExtra = [
  `<path d="M 12.5 30 C 18 27 27 27 32.5 30" style="fill:none;stroke:#fff"/>`,
  `<path d="M 12.5 33.5 C 18 30.5 27 30.5 32.5 33.5" style="fill:none;stroke:#fff"/>`,
  `<path d="M 12.5 37 C 18 34 27 34 32.5 37" style="fill:none;stroke:#fff"/>`,
];

const blackQueenExtra = [
  `<path d="M 11 29 C 18 31 27 31 34 29" style="fill:none;stroke:#fff"/>`,
  `<path d="M 12.5 31.5 L 32.5 31.5" style="fill:none;stroke:#fff"/>`,
  `<path d="M 11.5 34 C 18 35.5 27 35.5 33.5 34" style="fill:none;stroke:#fff"/>`,
];

const blackRookExtra = [
  `<path d="M 11 14 L 34 14" style="fill:none;stroke:#fff"/>`,
];

const blackBishopExtra = [
  `<path d="M 17.5 26 L 27.5 26" style="fill:none;stroke:#fff"/>`,
  `<path d="M 15 30 C 17.5 32.5 27.5 32.5 30 30" style="fill:none;stroke:#fff"/>`,
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

type PieceDef = { white: string; black: string };

function build(paths: string[], blackExtra: string[] = []): PieceDef {
  const whiteSvg = wrap(paths.join(''), whiteFill);
  // For black pieces, replace the inner-detail strokes with white versions.
  const blackPaths = paths
    .map((p) => p.replace(/style="fill:none"/g, 'style="fill:none;stroke:#fff"'))
    // Keep filled paths with default (black) stroke; only decorative lines get white.
    // Revert filled-path strokes that were accidentally changed.
    .map((p) => {
      if (!p.includes('fill:none')) return p;
      return p;
    });
  const blackSvg = wrap(
    paths.join('') + blackExtra.join(''),
    blackFill,
  );
  return { white: whiteSvg, black: blackSvg };
}

const pieces: Record<string, PieceDef> = {
  k: build(kingPaths, blackKingExtra),
  q: build(queenPaths, blackQueenExtra),
  r: build(rookPaths, blackRookExtra),
  b: build(bishopPaths, blackBishopExtra),
  n: build(knightPaths),
  p: build(pawnPaths),
};

/**
 * Return an inline `<svg>` string for a chess piece.
 *
 * @param piece FEN character: K Q R B N P (white) or k q r b n p (black).
 * @param size  Desired display size in pixels (width & height).
 * @returns     A complete `<svg>` element string.
 */
export function pieceSvg(piece: string, size: number): string {
  const lower = piece.toLowerCase();
  const def = pieces[lower];
  if (!def) {
    throw new Error(`Unknown piece character: "${piece}"`);
  }
  const isWhite = piece === piece.toUpperCase();
  const svg = isWhite ? def.white : def.black;
  // Inject width/height attributes into the opening <svg> tag.
  return svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
}
