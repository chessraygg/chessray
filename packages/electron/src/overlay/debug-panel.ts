import type { PipelineResult } from '@chessray/core';
import { savePrefs } from './preferences.js';

export const PIECE_UNICODE: Record<string, string> = {
  K: '\u2654', Q: '\u2655', R: '\u2656', B: '\u2657', N: '\u2658', P: '\u2659',
  k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F',
  '.': '\u00B7',
};

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

export function updateDebugPanel(
  result: PipelineResult,
  displayFlipped: boolean,
  debugPanel: HTMLDivElement | null,
  debugImg: HTMLImageElement | null,
  debugFen: HTMLDivElement | null,
  debugInfo: HTMLDivElement | null,
): void {
  if (!debugPanel) return;

  if (debugImg && result.board_image_url) {
    debugImg.src = result.board_image_url;
  }

  if (debugFen) {
    debugFen.textContent = result.recognition?.fen || 'No recognition';
  }

  // Update piece grid
  const grid = document.getElementById('cv-debug-grid');
  // highlighted_squares are in corrected (standard) orientation after recognizeBoard().
  // When flipped, the display grid is reversed — remap indices to display coords.
  const rawHl = result.highlighted_squares || [];
  const hl = new Set(result.flipped ? rawHl.map(i => 63 - i) : rawHl);
  if (grid && result.recognition?.fen) {
    let fenRows = result.recognition.fen.split('/');
    if (result.flipped) {
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
            html += `<span class="${sq}${hi} empty">\u00B7</span>`;
            file++;
          }
        } else {
          const sq = (rank + file) % 2 === 0 ? 'light' : 'dark';
          const hi = hl.has(rank * 8 + file) ? ' highlight' : '';
          html += `<span class="${sq}${hi} piece">${PIECE_UNICODE[ch] || ch}</span>`;
          file++;
        }
      }
      rank++;
    }
    grid.innerHTML = html;
  }

  // Turn indicator
  const turnDot = document.getElementById('cv-turn-dot');
  const turnText = document.getElementById('cv-turn-text');
  if (turnDot && turnText && result.evaluation?.fen) {
    const fenParts = result.evaluation.fen.split(' ');
    const turn = fenParts[1] || 'w';
    turnDot.className = `turn-dot ${turn === 'w' ? 'white' : 'black'}`;
    turnText.textContent = turn === 'w' ? 'White to move' : 'Black to move';
  }
  const pawnDir = document.getElementById('cv-pawn-dir');
  if (pawnDir) {
    pawnDir.textContent = result.flipped ? '\u2193' : '\u2191';
  }
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
  if (bestMoves && result.evaluation?.top_moves?.length) {
    let html = '';
    for (const move of result.evaluation.top_moves) {
      const scoreStr = move.score_cp >= 0 ? `+${(move.score_cp/100).toFixed(1)}` : (move.score_cp/100).toFixed(1);
      const lossStr = move.loss_cp > 0 ? ` (\u2212${move.loss_cp}cp)` : '';
      html += `<div class="move-line"><span class="move-score">${scoreStr}</span>${move.pv.slice(0, 5).join(' ')}${lossStr}</div>`;
    }
    bestMoves.innerHTML = html;
  }

  if (debugInfo) {
    const parts: string[] = [];
    if (result.recognition) {
      parts.push(`conf: ${(result.recognition.confidence * 100).toFixed(0)}%`);
    }
    parts.push(`${result.total_elapsed_ms}ms`);
    debugInfo.textContent = parts.join(' | ');
  }
}
