import type { PipelineResult } from '@chessray/core';
import { uciToSan, formatMoveLine } from '@chessray/core';
import { savePrefs } from './preferences.js';
import { pieceSvg } from './piece-svg.js';

export function setupDrag(handle: HTMLElement, panel: HTMLElement): void {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    // Don't drag when clicking buttons
    if ((e.target as HTMLElement).closest('button')) return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = `${startLeft + dx}px`;
    panel.style.top = `${startTop + dy}px`;
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      const rect = panel.getBoundingClientRect();
      savePrefs({ panelLeft: Math.round(rect.left), panelTop: Math.round(rect.top) });
    }
    isDragging = false;
  });
}

export function setTrackingState(tracking: boolean): void {
  const status = document.getElementById('cv-status');
  const content = document.getElementById('cv-tracking-content');
  if (status) {
    status.textContent = tracking ? 'Tracking active' : 'Waiting for source selection...';
    status.classList.toggle('tracking', tracking);
  }
  if (content) {
    content.classList.toggle('active', tracking);
  }
}

/** Render the virtual board grid with SVG pieces */
function renderBoardGrid(
  grid: HTMLElement,
  fen: string,
  flipped: boolean,
  highlightedSquares: number[],
): void {
  const rawHl = highlightedSquares || [];
  const hl = new Set(flipped ? rawHl.map(i => 63 - i) : rawHl);

  let fenRows = fen.split('/');
  if (flipped) {
    fenRows = fenRows.reverse().map(r => r.split('').reverse().join(''));
  }

  let html = '';
  let rank = 0;
  for (const row of fenRows) {
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch); i++) {
          const sq = (rank + file) % 2 === 0 ? 'light' : 'dark';
          const hi = hl.has(rank * 8 + file) ? ' highlight' : '';
          html += `<div class="sq ${sq}${hi}"></div>`;
          file++;
        }
      } else {
        const sq = (rank + file) % 2 === 0 ? 'light' : 'dark';
        const hi = hl.has(rank * 8 + file) ? ' highlight' : '';
        html += `<div class="sq ${sq}${hi}">${pieceSvg(ch, 22)}</div>`;
        file++;
      }
    }
    rank++;
  }
  grid.innerHTML = html;
}

/** Format best moves with SAN or UCI notation */
function renderBestMoves(
  container: HTMLElement,
  result: PipelineResult,
  useSan: boolean,
): void {
  if (!result.evaluation?.top_moves?.length) return;

  const fen = result.evaluation.fen;
  let html = '';
  for (const move of result.evaluation.top_moves) {
    const scoreStr = move.score_cp >= 0 ? `+${(move.score_cp/100).toFixed(1)}` : (move.score_cp/100).toFixed(1);
    const lossStr = move.loss_cp > 0 ? ` (\u2212${move.loss_cp}cp)` : '';

    let movesText: string;
    if (useSan && fen) {
      const sanMoves = uciToSan(fen, move.pv.slice(0, 5));
      const turn = fen.split(' ')[1] as 'w' | 'b' || 'w';
      movesText = formatMoveLine(sanMoves, turn);
    } else {
      movesText = move.pv.slice(0, 5).join(' ');
    }

    html += `<div class="move-line"><span class="move-score">${scoreStr}</span>${movesText}${lossStr}</div>`;
  }
  container.innerHTML = html;
}

export function updateDebugPanel(
  result: PipelineResult,
  displayFlipped: boolean,
  debugPanel: HTMLDivElement | null,
  debugImg: HTMLImageElement | null,
  debugFen: HTMLDivElement | null,
  debugInfo: HTMLDivElement | null,
  useSan: boolean,
): void {
  // Update debug panel elements
  if (debugImg && result.board_image_url) {
    debugImg.src = result.board_image_url;
  }

  if (debugFen) {
    debugFen.textContent = result.recognition?.fen || 'No recognition';
  }

  // Update virtual board grid (user panel)
  const grid = document.getElementById('cv-debug-grid');
  if (grid && result.recognition?.fen) {
    renderBoardGrid(grid, result.recognition.fen, !!result.flipped, result.highlighted_squares || []);
  }

  // Turn indicator
  const turnDot = document.getElementById('cv-turn-dot');
  const turnText = document.getElementById('cv-turn-text');
  if (turnDot && turnText && result.evaluation?.fen) {
    const fenParts = result.evaluation.fen.split(' ');
    const turn = fenParts[1] || 'w';
    turnDot.className = `turn-dot ${turn === 'w' ? 'white' : 'black'}`;
    turnText.textContent = turn === 'w' ? 'White' : 'Black';
  }

  // Orientation arrow
  const pawnDir = document.getElementById('cv-pawn-dir');
  if (pawnDir) {
    pawnDir.textContent = result.flipped ? '\u2B07' : '\u2B06';
  }

  // Debug orientation info
  const orientInfo = document.getElementById('cv-orientation-info');
  if (orientInfo) {
    const orientation = result.flipped ? 'white top' : 'white bottom';
    const sourceNames: Record<string, string> = {
      label: 'coord labels',
      pawn_move: 'pawn move',
      piece_count: 'piece positions',
    };
    const sourceLabel = sourceNames[result.orientation_source ?? ''] ?? '?';
    orientInfo.textContent = `${orientation} · ${sourceLabel}`;
  }

  // Eval bar
  const evalFill = document.getElementById('cv-eval-fill') as HTMLDivElement | null;
  const evalLabel = document.getElementById('cv-eval-label');
  if (evalFill && evalLabel && result.evaluation?.top_moves?.length) {
    const sideScore = result.evaluation.top_moves[0].score_cp;
    const turn = result.evaluation.fen?.split(' ')[1] || 'w';
    const bestScore = turn === 'b' ? -sideScore : sideScore;
    const winProb = 1 / (1 + Math.pow(10, -bestScore / 400));
    const fillPct = displayFlipped ? (1 - winProb) * 100 : winProb * 100;
    evalFill.style.width = `${fillPct.toFixed(1)}%`;
    evalFill.style.background = displayFlipped ? '#272727' : '#d4d4d4';
    evalFill.parentElement!.style.background = displayFlipped ? '#d4d4d4' : '#272727';

    if (Math.abs(bestScore) >= 9000) {
      const mateIn = bestScore > 0 ? 10000 - bestScore : -(10000 + bestScore);
      evalLabel.textContent = `M${Math.abs(mateIn)}`;
    } else {
      const scoreStr = bestScore >= 0 ? `+${(bestScore/100).toFixed(1)}` : (bestScore/100).toFixed(1);
      evalLabel.textContent = scoreStr;
    }
  }

  // Depth
  const depthLabel = document.getElementById('cv-eval-depth');
  if (depthLabel && result.eval_depth) {
    depthLabel.textContent = `d${result.eval_depth}`;
  }

  // Best moves
  const bestMoves = document.getElementById('cv-best-moves');
  if (bestMoves) {
    renderBestMoves(bestMoves, result, useSan);
  }

  // Debug meta info
  if (debugInfo) {
    const parts: string[] = [];
    if (result.recognition) {
      parts.push(`conf: ${(result.recognition.confidence * 100).toFixed(0)}%`);
    }
    parts.push(`${result.total_elapsed_ms}ms`);
    debugInfo.textContent = parts.join(' | ');
  }
}
