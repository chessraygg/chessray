/**
 * Content script: injects a transparent overlay into the active tab and
 * renders arrows + eval bar on top of the chess board.
 *
 * Reads the same PipelineResult shape the Electron overlay uses. This is
 * still the bare-bones renderer; the full @chessray/overlay-ui package
 * (canvas-renderer + draggable panel) is wired in in a later phase.
 *
 * Coordinate math assumes the captured stream matches the tab viewport 1:1
 * (modulo devicePixelRatio). Real sites scroll, zoom, and show boards
 * inside iframes — proper bbox→viewport calibration is a known TODO.
 */

import type { PipelineResult } from '@chessray/core';
import type { ExtensionMessage } from '../shared/messages.js';

const OVERLAY_ID = 'chessray-ext-overlay';

function ensureOverlay(): HTMLCanvasElement {
  let canvas = document.getElementById(OVERLAY_ID) as HTMLCanvasElement | null;
  if (canvas) return canvas;

  canvas = document.createElement('canvas');
  canvas.id = OVERLAY_ID;
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: '2147483647',
  } as CSSStyleDeclaration);
  document.documentElement.appendChild(canvas);

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    canvas!.width = Math.round(window.innerWidth * dpr);
    canvas!.height = Math.round(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener('resize', resize);
  return canvas;
}

function squareToPixel(
  square: string,
  x: number, y: number, size: number,
  flipped: boolean,
): { cx: number; cy: number } {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10) - 1;
  const f = flipped ? 7 - file : file;
  const r = flipped ? rank : 7 - rank;
  const sq = size / 8;
  return { cx: x + (f + 0.5) * sq, cy: y + (r + 0.5) * sq };
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number, fromY: number, toX: number, toY: number,
  color: string, width: number, opacity: number,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = opacity;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';

  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (len === 0) { ctx.restore(); return; }

  const headLen = Math.min(24, len * 0.3);
  const headAngle = Math.atan2(dy, dx);
  const tipX = toX - (dx / len) * (headLen * 0.5);
  const tipY = toY - (dy / len) * (headLen * 0.5);

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLen * Math.cos(headAngle - Math.PI / 6), toY - headLen * Math.sin(headAngle - Math.PI / 6));
  ctx.lineTo(toX - headLen * Math.cos(headAngle + Math.PI / 6), toY - headLen * Math.sin(headAngle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawEvalBar(
  ctx: CanvasRenderingContext2D,
  scoreCp: number,
  x: number, y: number, height: number,
): void {
  const barWidth = 18;
  const clamped = Math.max(-1500, Math.min(1500, scoreCp));
  const whiteFrac = 0.5 + (clamped / 3000);
  const whiteH = height * whiteFrac;

  ctx.save();
  ctx.fillStyle = '#222';
  ctx.fillRect(x, y, barWidth, height);
  ctx.fillStyle = '#eee';
  ctx.fillRect(x, y + (height - whiteH), barWidth, whiteH);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, barWidth, height);
  ctx.restore();
}

function render(result: PipelineResult): void {
  const canvas = ensureOverlay();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  const bbox = result.board_detection?.bbox;
  if (!bbox) return;
  // Captured stream pixels → viewport CSS pixels. Works when the capture
  // matches the viewport (single-monitor, no zoom). Refine later.
  const scale = window.innerWidth / Math.max(1, bbox.width + bbox.x * 2);
  const bx = bbox.x * scale;
  const by = bbox.y * scale;
  const bw = bbox.width * scale;

  const flipped = result.flipped ?? false;
  for (const a of result.arrows) {
    const from = squareToPixel(a.from, bx, by, bw, flipped);
    const to = squareToPixel(a.to, bx, by, bw, flipped);
    drawArrow(ctx, from.cx, from.cy, to.cx, to.cy, a.color, a.width, a.opacity);
  }

  const scoreCp = result.evaluation?.top_moves[0]?.score_cp ?? 0;
  drawEvalBar(ctx, scoreCp, Math.max(0, bx - 28), by, bw);
}

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type === 'frame-result') {
    render(msg.result);
  }
});
