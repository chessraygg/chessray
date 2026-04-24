/**
 * Message types for service worker ⇄ offscreen doc ⇄ content script.
 *
 * All cross-context chatter flows through `chrome.runtime.sendMessage` /
 * `chrome.tabs.sendMessage`, which serializes everything as JSON. Anything
 * that can't round-trip through JSON (ImageData, MediaStream, ArrayBuffer)
 * must be transferred by reference (streamId) or sent over a dedicated port.
 */

import type { EvalResult, BoardBBox } from '@chessray/core';

/** Simplified pipeline output for the content-script overlay. */
export interface ExtensionFrameResult {
  bbox: BoardBBox | null;
  fen: string | null;
  evaluation: EvalResult | null;
  arrows: Array<{ from: string; to: string; color: string; width: number; opacity: number }>;
  flipped: boolean;
  status?: string;
}

export type ExtensionMessage =
  | { type: 'start-capture'; tabId: number }
  | { type: 'stop-capture' }
  | { type: 'capture-started'; streamId: string }
  | { type: 'frame-result'; result: ExtensionFrameResult }
  | { type: 'status'; message: string }
  | { type: 'ping' };
