import type { PipelineResult } from '../shared/types.js';
import { uciToSan, formatMoveLine, type Turn } from '@chessray/core';
import { lossToColor } from '../shared/arrows.js';
import { rgbToCss, squareColorPalette, type RGB } from '../shared/colors.js';
import { savePrefs } from './preferences.js';
import { pieceSvg } from './piece-svg.js';

/** Clear all debug panel content when no board is detected */
export function clearDebugPanel(
  debugImg: HTMLImageElement | null,
  debugFen: HTMLDivElement | null,
  debugInfo: HTMLDivElement | null,
): void {
  if (debugImg) { debugImg.src = ''; debugImg.style.display = 'none'; }
  if (debugFen) debugFen.textContent = 'No board detected';
  if (debugInfo) debugInfo.textContent = '';

  const grid = document.getElementById('cv-debug-grid');
  if (grid && !(window as any).__chessrayPvPlaying) grid.innerHTML = '';

  const bestMoves = document.getElementById('cv-best-moves');
  if (bestMoves) { bestMoves.innerHTML = ''; bestMoves.dataset.lastHtml = ''; }

  const evalFill = document.getElementById('cv-eval-fill') as HTMLDivElement | null;
  const evalLabel = document.getElementById('cv-eval-label');
  const depthLabel = document.getElementById('cv-eval-depth');
  if (evalFill) { evalFill.style.width = '50%'; evalFill.style.background = '#d4d4d4'; evalFill.parentElement!.style.background = '#272727'; }
  if (evalLabel) evalLabel.textContent = '';
  if (depthLabel) depthLabel.textContent = '';

  const turnDot = document.getElementById('cv-turn-dot');
  const turnText = document.getElementById('cv-turn-text');
  if (turnDot) turnDot.className = 'turn-dot';
  if (turnText) turnText.textContent = '';

  const hlDebug = document.getElementById('cv-highlight-debug');
  if (hlDebug) hlDebug.innerHTML = '';
}

export function setupDrag(handle: HTMLElement, panel: HTMLElement): void {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    // Don't drag when clicking interactive elements or anything inside the split layout
    // (which has its own drag handles on section headers and splitters).
    if ((e.target as HTMLElement).closest('button, input, select, textarea, .move-line, .split-root, .hidden-tray, .resize-grip')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    // Use offsetLeft/Top (unscaled CSS position) — getBoundingClientRect()
    // returns scaled values which causes a jump when CSS transform:scale is applied.
    startLeft = panel.offsetLeft;
    startTop = panel.offsetTop;
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
      savePrefs({ panelLeft: panel.offsetLeft, panelTop: panel.offsetTop });
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

/** Render the virtual board grid with SVG pieces. Square colors come from the
 * detected real-board theme (when available). When the grid is in analysis mode
 * (CSS class `analysis`), colors are brightened to signal projected content. */
export function renderBoardGrid(
  grid: HTMLElement,
  fen: string,
  flipped: boolean,
  highlightedSquares: number[],
  squareColors?: { light: RGB; dark: RGB } | null,
): void {
  const rawHl = highlightedSquares || [];
  const hl = new Set(flipped ? rawHl.map(i => 63 - i) : rawHl);

  let fenRows = fen.split('/');
  if (flipped) {
    fenRows = fenRows.reverse().map(r => r.split('').reverse().join(''));
  }

  const palette = squareColorPalette(squareColors, {
    analysis: grid.classList.contains('analysis'),
  });
  const bg = (isLight: boolean, isHl: boolean): string =>
    rgbToCss(isHl
      ? (isLight ? palette.lightHl : palette.darkHl)
      : (isLight ? palette.light : palette.dark));

  let html = '';
  let rank = 0;
  for (const row of fenRows) {
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch); i++) {
          const isLight = (rank + file) % 2 === 0;
          const isHl = hl.has(rank * 8 + file);
          html += `<div class="sq" style="background:${bg(isLight, isHl)}"></div>`;
          file++;
        }
      } else {
        const isLight = (rank + file) % 2 === 0;
        const isHl = hl.has(rank * 8 + file);
        html += `<div class="sq" style="background:${bg(isLight, isHl)}">${pieceSvg(ch, 22)}</div>`;
        file++;
      }
    }
    rank++;
  }
  grid.innerHTML = html;
}

/** Format best moves with SAN or UCI notation, clickable to select line */
function renderBestMoves(
  container: HTMLElement,
  result: PipelineResult,
  useSan: boolean,
  selectedLineIndex: number,
  lineVisible: boolean,
  lossThreshold: number,
  onSelectLine: (index: number) => void,
): void {
  if (!result.evaluation?.top_moves?.length) return;

  const fen = result.evaluation.fen;
  let html = '';
  const moves = result.evaluation.top_moves.filter(m => m.loss_cp <= lossThreshold);
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const origIdx = result.evaluation.top_moves.indexOf(move);
    const scoreStr = move.score_cp >= 0 ? `+${(move.score_cp/100).toFixed(1)}` : (move.score_cp/100).toFixed(1);
    const lossStr = move.loss_cp > 0 ? ` (\u2212${move.loss_cp}cp)` : '';
    const selected = lineVisible && origIdx === selectedLineIndex ? ' selected' : '';

    let movesText: string;
    if (useSan && fen) {
      const sanMoves = uciToSan(fen, move.pv.slice(0, 5));
      const turn = fen.split(' ')[1] as Turn || 'w';
      movesText = formatMoveLine(sanMoves, turn);
    } else {
      movesText = move.pv.slice(0, 5).join(' ');
    }

    // Subtle background matching arrow color gradient
    const hex = lossToColor(move.loss_cp);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const bg = `rgba(${r},${g},${b},0.12)`;

    html += `<div class="move-line${selected}" data-line="${origIdx}" style="background:${bg}"><span class="move-score">${scoreStr}</span>${movesText}${lossStr}</div>`;
  }
  // Skip DOM rebuild if content unchanged (prevents hover flicker at 2fps)
  if (container.dataset.lastHtml === html) return;
  container.dataset.lastHtml = html;
  container.innerHTML = html;

  // Attach click handlers
  container.querySelectorAll('.move-line').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt((el as HTMLElement).dataset.line!, 10);
      onSelectLine(idx);
    });
  });
}

export function updateDebugPanel(
  result: PipelineResult,
  displayFlipped: boolean,
  debugImg: HTMLImageElement | null,
  debugFen: HTMLDivElement | null,
  debugInfo: HTMLDivElement | null,
  useSan: boolean,
  selectedLineIndex: number,
  lineVisible: boolean,
  lossThreshold: number,
  onSelectLine: (index: number) => void,
): void {
  if (debugImg && result.board_image_url) {
    debugImg.src = result.board_image_url;
    debugImg.style.display = '';
  }

  if (debugFen) {
    // Show full FEN (with turn, castling rights) if available, else position-only
    debugFen.textContent = result.evaluation?.fen || result.recognition?.fen || 'No recognition';
  }

  // Update virtual board grid (user panel) — skip while PV playback is animating
  const grid = document.getElementById('cv-debug-grid');
  if (grid && result.recognition?.fen && !(window as any).__chessrayPvPlaying) {
    renderBoardGrid(grid, result.recognition.fen, !!result.flipped, result.highlighted_squares || [], result.square_colors);
  }

  // Turn indicator — use highlight-based turn (always current), fall back to eval FEN
  const turnDot = document.getElementById('cv-turn-dot');
  const turnText = document.getElementById('cv-turn-text');
  if (turnDot && turnText) {
    const turn = result.turn ?? result.evaluation?.fen?.split(' ')[1] ?? null;
    if (turn) {
      turnDot.className = `turn-dot ${turn === 'w' ? 'white' : 'black'}`;
      turnText.textContent = turn === 'w' ? "White's turn" : "Black's turn";
    }
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
  const depthLabel = document.getElementById('cv-eval-depth');

  if (evalFill && evalLabel) {
    if (result.game_over === 'checkmate') {
      // Checkmate: loser's turn, so winner is opposite
      const loserIsWhite = result.turn === 'w';
      evalFill.style.width = loserIsWhite ? '0%' : '100%';
      evalFill.style.background = '#d4d4d4';
      evalFill.parentElement!.style.background = '#272727';
      evalLabel.textContent = '#';
      if (depthLabel) depthLabel.textContent = '';
    } else if (result.game_over === 'stalemate') {
      evalFill.style.width = '50%';
      evalFill.style.background = '#888';
      evalFill.parentElement!.style.background = '#888';
      evalLabel.textContent = '½–½';
      if (depthLabel) depthLabel.textContent = '';
    } else if (result.evaluation?.top_moves?.length) {
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

      if (depthLabel && result.eval_depth) {
        depthLabel.textContent = `d${result.eval_depth}`;
      }
    }
  }

  // Best moves
  const bestMoves = document.getElementById('cv-best-moves');
  if (bestMoves) {
    if (result.game_over) {
      const msg = result.game_over === 'checkmate'
        ? `Checkmate — ${result.turn === 'w' ? 'Black' : 'White'} wins`
        : 'Stalemate — Draw';
      const html = `<div class="move-line" style="background:rgba(255,255,255,0.05);justify-content:center;color:var(--text-dim)">${msg}</div>`;
      if (bestMoves.dataset.lastHtml !== html) {
        bestMoves.dataset.lastHtml = html;
        bestMoves.innerHTML = html;
      }
    } else {
      renderBestMoves(bestMoves, result, useSan, selectedLineIndex, lineVisible, lossThreshold, onSelectLine);
    }
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

  // Detection status
  const statusEl = document.getElementById('cv-detection-status');
  if (statusEl) {
    if (result.detection_status) {
      statusEl.textContent = result.detection_status;
      statusEl.style.display = '';
    } else {
      statusEl.style.display = 'none';
    }
  }

  // Highlight detection debug breakdown
  const hlDebugEl = document.getElementById('cv-highlight-debug');
  if (hlDebugEl) renderHighlightDebug(hlDebugEl, result);
}

const reasonLabel: Record<string, string> = {
  initial_top_score: 'top score among legal pairs in initial candidates',
  expanded_natural_pair: 'most natural legal pair (expanded search)',
  no_legal_pair: 'no legal pair found',
};

function rgbSwatch([r, g, b]: [number, number, number]): string {
  return `<span class="sw" style="background:rgb(${r},${g},${b})"></span>`;
}

function renderHighlightDebug(container: HTMLElement, result: PipelineResult): void {
  const d = result.highlight_debug;
  if (!d) { container.innerHTML = ''; return; }

  const flags: string[] = [];
  if (d.midAnimation) flags.push('<span class="hl-flag warn">mid-animation</span>');
  if (d.invalidHighlights) flags.push('<span class="hl-flag err">invalid (no legal pair)</span>');
  const flagsLine = flags.length ? `<div class="hl-flags">${flags.join(' ')}</div>` : '';

  const mediansLine = `<div class="hl-row"><span class="hl-k">medians</span>`
    + ` ${rgbSwatch(d.medians.light)} light`
    + ` ${rgbSwatch(d.medians.dark)} dark</div>`;

  const timingLine = `<div class="hl-row"><span class="hl-k">timing</span>`
    + ` detect ${d.timing.highlights_ms}ms · disamb ${d.timing.disambiguate_ms}ms</div>`;

  const candHtml = d.candidates.length
    ? d.candidates.map(c => {
        const glyph = c.piece ?? '·';
        return `<span class="hl-cand">${c.square}<span class="hl-score">${c.score.toFixed(0)}</span><span class="hl-glyph">${glyph}</span></span>`;
      }).join(' ')
    : '<span class="hl-dim">none</span>';
  const candsLine = `<div class="hl-row"><span class="hl-k">candidates (${d.candidates.length})</span> ${candHtml}</div>`;

  const disamb = d.disambiguation;
  let pairsLine = '';
  if (disamb.validPairs.length > 0 || disamb.rejectedCount > 0) {
    const winnerKey = disamb.winner ? `${disamb.winner.src}${disamb.winner.dest}` : '';
    const sorted = [...disamb.validPairs].sort((a, b) => b.combinedScore - a.combinedScore);
    const pairHtml = sorted.map(p => {
      const isWinner = `${p.src}${p.dest}` === winnerKey;
      const natural = Math.max(p.srcNaturalness, p.destNaturalness) <= 0.08;
      const tag = isWinner ? ' winner' : '';
      const natTag = natural ? '<span class="hl-natural">natural</span>' : '<span class="hl-anno">annotation</span>';
      return `<div class="hl-pair${tag}">`
        + `<span class="hl-pair-move">${p.src}→${p.dest}</span>`
        + `<span class="hl-pair-piece">${p.piece}</span>`
        + `<span class="hl-pair-score">score ${p.combinedScore.toFixed(0)}</span>`
        + `<span class="hl-pair-pass">p${p.pass}</span>`
        + natTag
        + `</div>`;
    }).join('');
    const rejTag = disamb.rejectedCount > 0
      ? `<span class="hl-rejected">+${disamb.rejectedCount} rejected (illegal move)</span>`
      : '';
    pairsLine = `<div class="hl-row"><span class="hl-k">legal pairs (${disamb.validPairs.length})</span> ${rejTag}</div>`
      + `<div class="hl-pairs">${pairHtml}</div>`;
  }

  let winnerLine = '';
  if (disamb.winner) {
    const reason = reasonLabel[disamb.winner.reason] ?? disamb.winner.reason;
    winnerLine = `<div class="hl-row hl-winner"><span class="hl-k">winner</span> ${disamb.winner.src}→${disamb.winner.dest} — ${reason}</div>`;
  } else if (d.candidates.length > 0) {
    winnerLine = `<div class="hl-row hl-winner"><span class="hl-k">winner</span> none — ${reasonLabel.no_legal_pair}</div>`;
  }

  container.innerHTML = flagsLine + candsLine + mediansLine + pairsLine + winnerLine + timingLine;
}
