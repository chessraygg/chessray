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

  // Debug meta info — confidence + frame loop timing breakdown
  if (debugInfo) {
    renderFrameTiming(debugInfo, result);
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

const HL_TIPS = {
  candidates: 'Squares whose border-frame median color shifted enough vs the parity median to be flagged as possibly highlighted (last-move overlay). Sorted by score; small dot = empty square, letter = piece on that square.',
  medians: 'Median RGB color of the board\'s light and dark squares (sampled from the inner 6×6 to skip edge labels and pieces). Used as the baseline that highlight scoring measures deviation from.',
  legalPairs: 'Candidate (source → destination) pairs that form a geometrically legal move for the piece on the destination square. The disambiguator picks one of these as the highlighted move.',
  winner: 'The (source, destination) pair the disambiguator picked as the actual last move, plus the reason it won (top score, most natural pair, or none if no legal pair was found).',
  midAnim: 'A piece is mid-animation between squares — recognition would read garbage so this frame is skipped and the previous result is reused.',
  invalid: 'Highlights were detected but no legal (source, destination) pair could be formed. The frame is rejected rather than guessing a wrong move.',
} as const;

function renderHighlightDebug(container: HTMLElement, result: PipelineResult): void {
  const d = result.highlight_debug;
  if (!d) { container.innerHTML = ''; return; }

  const flags: string[] = [];
  if (d.midAnimation) flags.push(`<span class="hl-flag warn"${tip(HL_TIPS.midAnim)} data-tip-pos="left">mid-animation</span>`);
  if (d.invalidHighlights) flags.push(`<span class="hl-flag err"${tip(HL_TIPS.invalid)} data-tip-pos="left">invalid (no legal pair)</span>`);
  const flagsLine = flags.length ? `<div class="hl-flags">${flags.join(' ')}</div>` : '';

  const mediansLine = `<div class="hl-row"><span class="hl-k"${tip(HL_TIPS.medians)} data-tip-pos="left">medians</span>`
    + ` ${rgbSwatch(d.medians.light)} light`
    + ` ${rgbSwatch(d.medians.dark)} dark</div>`;

  const candHtml = d.candidates.length
    ? d.candidates.map(c => {
        const glyph = c.piece ?? '·';
        return `<span class="hl-cand">${c.square}<span class="hl-score">${c.score.toFixed(0)}</span><span class="hl-glyph">${glyph}</span></span>`;
      }).join(' ')
    : '<span class="hl-dim">none</span>';
  const candsLine = `<div class="hl-row"><span class="hl-k"${tip(HL_TIPS.candidates)} data-tip-pos="left">candidates (${d.candidates.length})</span> ${candHtml}</div>`;

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
    pairsLine = `<div class="hl-row"><span class="hl-k"${tip(HL_TIPS.legalPairs)} data-tip-pos="left">legal pairs (${disamb.validPairs.length})</span> ${rejTag}</div>`
      + `<div class="hl-pairs">${pairHtml}</div>`;
  }

  let winnerLine = '';
  if (disamb.winner) {
    const reason = reasonLabel[disamb.winner.reason] ?? disamb.winner.reason;
    winnerLine = `<div class="hl-row hl-winner"><span class="hl-k"${tip(HL_TIPS.winner)} data-tip-pos="left">winner</span> ${disamb.winner.src}→${disamb.winner.dest} — ${reason}</div>`;
  } else if (d.candidates.length > 0) {
    winnerLine = `<div class="hl-row hl-winner"><span class="hl-k"${tip(HL_TIPS.winner)} data-tip-pos="left">winner</span> none — ${reasonLabel.no_legal_pair}</div>`;
  }

  container.innerHTML = flagsLine + candsLine + mediansLine + pairsLine + winnerLine;
}

/** Color level for a duration. Used to tint timing bars and the total bar.
 *  Per-section uses the tighter scale; the total bar uses the wider scale
 *  because it sums many stages. */
type FtLevel = 'fast' | 'ok' | 'mid' | 'slow' | 'over';
function levelForSection(ms: number): FtLevel {
  if (ms < 25) return 'fast';
  if (ms < 75) return 'ok';
  if (ms < 200) return 'mid';
  if (ms < 400) return 'slow';
  return 'over';
}
function levelForTotal(ms: number): FtLevel {
  if (ms < 100) return 'fast';
  if (ms < 250) return 'ok';
  if (ms < 400) return 'mid';
  if (ms < 500) return 'slow';
  return 'over';
}

interface FtRow {
  key: string;
  label: string;
  ms: number;
  /** Mark dimmed when the stage was skipped/cached so the breakdown still
   *  shows the slot but signals it didn't run this frame. */
  dim?: boolean;
}

/** Tooltip text for each timing row. Keyed by FtRow.key so the same description
 *  is reused if a row is re-labeled (e.g. "detect" vs "detect (skip)"). */
const FT_TIPS: Record<string, string> = {
  capture: 'Pulling the latest video frame from the OS desktop capture stream and copying its pixels into a canvas (drawImage + getImageData). Runs once per frame at the configured FPS.',
  fingerprint: 'Cheap pixel sample of the screen area outside the cached board bbox. When this fingerprint is unchanged, the board hasn\'t moved on screen and YOLO board detection can be skipped on this frame.',
  detect: 'YOLOv11n board detection: locates the chessboard bounding box in the captured frame. Runs when the fingerprint changes or every 30 frames as a safety refresh.',
  'detect-skip': 'Board detection was skipped this frame because the fingerprint outside the cached bbox was unchanged. The cached bbox from a previous frame is reused.',
  crop: 'Slicing the detected board region out of the full captured frame into a smaller pixel buffer.',
  preview: 'Encoding the cropped board into a JPEG data URL for the debug panel preview image. Runs in the renderer (canvas.toDataURL).',
  changedet: 'Sampling the cropped board pixels and comparing them to the previous frame. When unchanged, recognition is skipped and the cached recognition result is reused.',
  'yolo-prep': 'Preprocessing the cropped board for YOLO piece detection: resize to model input size and convert pixels to the float tensor layout the network expects.',
  'yolo-infer': 'YOLOv11n piece detection forward pass: predicts piece class + bounding box for every piece on the cropped board. Usually the single most expensive stage on cold frames.',
  'yolo-post': 'Post-processing YOLO outputs: NMS, confidence filtering, and mapping detected boxes to grid squares to build a 64-square piece array.',
  pieces: 'Total recognition wrapper: orchestrates YOLO prep/infer/post plus per-square label assignment to produce the raw 64-square piece array.',
  orient: 'Board orientation detection: piece-position heuristic + Tesseract OCR fallback to decide whether white is at the top or bottom of the captured board.',
  highlights: 'Per-square highlight scoring. Compares each square\'s border-frame median color to the parity median to find squares tinted by the last-move highlight overlay.',
  disamb: 'Highlight disambiguation: filters candidate squares to a legal (source, destination) pair by checking piece movement rules. Picks the most balanced and natural pair when several are legal.',
  pawn: 'Refinement pass for pawn detections (which YOLO often confuses with empty squares or other pawns). Uses orientation + per-square cues to fix ambiguous pawn rows.',
  turn: 'Decides whose turn it is from the highlighted source/destination squares and the piece on the destination — uppercase piece means White just moved, so it\'s Black\'s turn.',
  fenbuild: 'Building the full 6-field FEN string (position + side to move + castling + en passant + clocks) from the recognized position and detected turn.',
  gameover: 'Detecting checkmate or stalemate via chess.js (constructs a Chess instance from the FEN and asks isCheckmate / isStalemate).',
  seqmove: 'Detecting the move that was played between the previous position and the current one (used to compute centipawn loss for the move that was played).',
  ipc: 'Time the PipelineResult took to travel from the analysis renderer process to the overlay renderer process via Electron IPC (sent_at → received_at).',
  render: 'DOM update time of the previous frame (board grid, eval bar, best moves, this debug panel). Shown for the previous frame because the current frame\'s render isn\'t finished until after this number is written.',
  total: 'Whole-frame budget: pipeline work (capture → seq move) + IPC delivery + previous-frame render. At 2 FPS the budget per frame is 500ms; values above 500ms mean the next captured frame is dropped because the previous one was still processing.',
  conf: 'YOLO recognition confidence (mean per-square classification probability) for the piece grid extracted on this frame. Below 30% the frame is shown as low-confidence and not evaluated.',
  eval: 'Stockfish evaluation timing: depth of the most recently completed search and how many milliseconds that depth took. Eval runs asynchronously in the background and is not part of the per-frame budget.',
  'recog-cached': 'Recognition was skipped because the cropped board pixels were unchanged from the previous frame; the previous recognition result was reused.',
};

function tip(text: string | undefined): string {
  if (!text) return '';
  // Quote-safe HTML attribute encoding for inline data-tip attributes.
  const safe = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return ` data-tip="${safe}"`;
}

function renderFrameTiming(container: HTMLElement, result: PipelineResult): void {
  const ft = result.frame_timing;
  if (!ft) {
    // Fallback for results without frame_timing (e.g., no-board frames).
    const conf = result.recognition ? `conf ${(result.recognition.confidence * 100).toFixed(0)}% · ` : '';
    container.innerHTML = `<div class="ft-fallback">${conf}${result.total_elapsed_ms}ms</div>`;
    return;
  }

  const rb = ft.recog_breakdown;
  const recogChildren: FtRow[] = rb
    ? [
        { key: 'yolo-prep', label: 'yolo prep', ms: rb.yolo_prep_ms },
        { key: 'yolo-infer', label: 'yolo infer', ms: rb.yolo_infer_ms },
        { key: 'yolo-post', label: 'yolo post', ms: rb.yolo_post_ms },
        { key: 'pieces', label: 'pieces', ms: rb.pieces_ms },
        { key: 'orient', label: 'orientation', ms: rb.orientation_ms },
        { key: 'highlights', label: 'highlights', ms: rb.highlights_ms },
        { key: 'disamb', label: 'disambiguate', ms: rb.disambiguate_ms },
        { key: 'pawn', label: 'pawn refine', ms: rb.pawn_refine_ms },
        { key: 'turn', label: 'turn', ms: rb.turn_ms },
      ]
    : [{ key: 'recog-cached', label: 'recog (cached)', ms: ft.recog_ms, dim: true }];

  const stages: FtRow[] = [
    { key: 'capture', label: 'capture', ms: ft.capture_ms },
    { key: 'fingerprint', label: 'fingerprint', ms: ft.fingerprint_ms },
    { key: ft.detect_skipped ? 'detect-skip' : 'detect', label: ft.detect_skipped ? 'detect (skip)' : 'detect', ms: ft.detect_ms, dim: ft.detect_skipped },
    { key: 'crop', label: 'crop', ms: ft.crop_ms },
    { key: 'preview', label: 'preview', ms: ft.preview_ms },
    { key: 'changedet', label: 'change det', ms: ft.change_detect_ms },
    ...recogChildren,
    { key: 'fenbuild', label: 'fen build', ms: ft.fen_build_ms },
    { key: 'gameover', label: 'game over', ms: ft.game_over_ms },
    { key: 'seqmove', label: 'seq move', ms: ft.seq_move_ms },
    { key: 'ipc', label: 'ipc', ms: ft.ipc_ms ?? 0 },
    { key: 'render', label: 'render (prev)', ms: ft.render_ms ?? 0, dim: (ft.render_ms ?? 0) === 0 },
  ];

  // Total = capture + pipeline + ipc + render. Capture happens upstream of
  // processFrame (in the capture interval) so pipeline_ms doesn't include it.
  // The async eval is shown separately because it doesn't gate the next frame.
  const ipcMs = ft.ipc_ms ?? 0;
  const renderMs = ft.render_ms ?? 0;
  const total = ft.capture_ms + ft.pipeline_ms + ipcMs + renderMs;
  const totalLevel = levelForTotal(total);

  const conf = result.recognition ? `${(result.recognition.confidence * 100).toFixed(0)}%` : '—';
  const evalText = ft.eval_depth != null && ft.eval_ms != null
    ? `eval d${ft.eval_depth} · ${ft.eval_ms}ms`
    : '';

  // Stacked bar: each stage gets a slice proportional to its time. Min total
  // is clamped so an idle frame still renders a visible row.
  const stackBudget = Math.max(total, 1);
  const stackHtml = stages
    .filter(s => s.ms > 0)
    .map(s => {
      const pct = (s.ms / stackBudget) * 100;
      const lvl = levelForSection(s.ms);
      return `<div class="ft-seg ft-${lvl}" style="flex:0 0 ${pct.toFixed(2)}%" title="${s.label}: ${s.ms}ms"></div>`;
    }).join('');

  // Per-row breakdown: label, mini bar, ms. Bar width is relative to the
  // largest stage so small stages still register visually.
  const maxRowMs = Math.max(1, ...stages.map(s => s.ms));
  const rowsHtml = stages.map(s => {
    const lvl = levelForSection(s.ms);
    const pct = (s.ms / maxRowMs) * 100;
    const dim = s.dim ? ' ft-row-dim' : '';
    return `<div class="ft-row${dim}">`
      + `<span class="ft-label"${tip(FT_TIPS[s.key])} data-tip-pos="left">${s.label}</span>`
      + `<span class="ft-rowbar"><span class="ft-rowbar-fill ft-${lvl}" style="width:${pct.toFixed(2)}%"></span></span>`
      + `<span class="ft-ms ft-ms-${lvl}">${s.ms}ms</span>`
      + `</div>`;
  }).join('');

  container.innerHTML =
    `<div class="ft-total ft-${totalLevel}"${tip(FT_TIPS.total)} data-tip-pos="left">`
      + `<span class="ft-total-label">frame</span>`
      + `<span class="ft-total-ms">${total}ms</span>`
      + `<span class="ft-meta">`
        + `<span${tip(FT_TIPS.conf)} data-tip-pos="right">conf ${conf}</span>`
        + (evalText ? ` · <span class="ft-eval"${tip(FT_TIPS.eval)} data-tip-pos="right">${evalText}</span>` : '')
      + `</span>`
    + `</div>`
    + `<div class="ft-stack" data-tip="Each stage as a slice of the total ${total}ms frame budget. Hover any per-row label below for stage detail.">${stackHtml}</div>`
    + `<div class="ft-rows">${rowsHtml}</div>`;
}
