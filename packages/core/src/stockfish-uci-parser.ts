/**
 * Parse a single UCI "info" line from Stockfish output.
 */
export interface UciInfo {
  depth: number;
  multipv: number;
  scoreCp: number;
  isMate: boolean;
  mateIn: number | null;
  pv: string[];
  nodes?: number;
  nps?: number;
  time?: number;
}

/**
 * Parse a UCI info line. Returns null if the line is not a parseable info line.
 */
export function parseInfoLine(line: string): UciInfo | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;

  const tokens = line.split(' ');
  let depth = 0;
  let multipv = 1;
  let scoreCp = 0;
  let isMate = false;
  let mateIn: number | null = null;
  let pv: string[] = [];
  let nodes: number | undefined;
  let nps: number | undefined;
  let time: number | undefined;

  for (let i = 0; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth':
        depth = parseInt(tokens[++i], 10);
        break;
      case 'multipv':
        multipv = parseInt(tokens[++i], 10);
        break;
      case 'score':
        if (tokens[i + 1] === 'cp') {
          scoreCp = parseInt(tokens[i + 2], 10);
          i += 2;
        } else if (tokens[i + 1] === 'mate') {
          isMate = true;
          mateIn = parseInt(tokens[i + 2], 10);
          // Convert mate to a large centipawn value
          scoreCp = mateIn > 0 ? 10000 - mateIn : -10000 - mateIn;
          i += 2;
        }
        break;
      case 'nodes':
        nodes = parseInt(tokens[++i], 10);
        break;
      case 'nps':
        nps = parseInt(tokens[++i], 10);
        break;
      case 'time':
        time = parseInt(tokens[++i], 10);
        break;
      case 'pv':
        pv = tokens.slice(i + 1);
        i = tokens.length; // stop parsing
        break;
    }
  }

  if (depth === 0) return null;

  return { depth, multipv, scoreCp, isMate, mateIn, pv, nodes, nps, time };
}

/**
 * Parse a "bestmove" line.
 */
export function parseBestMove(line: string): { bestmove: string; ponder?: string } | null {
  if (!line.startsWith('bestmove ')) return null;
  const tokens = line.split(' ');
  return {
    bestmove: tokens[1],
    ponder: tokens[3],
  };
}
