/**
 * Message types for service worker ⇄ offscreen doc ⇄ content script.
 *
 * All cross-context chatter flows through `chrome.runtime.sendMessage` /
 * `chrome.tabs.sendMessage`, which serializes everything as JSON. Anything
 * that can't round-trip through JSON (ImageData, MediaStream, ArrayBuffer)
 * must be transferred by reference (streamId) or sent over a dedicated port.
 */

import type { PipelineResult } from '@chessray/core';

export type ExtensionMessage =
  | { type: 'start-capture'; tabId: number }
  | { type: 'stop-capture' }
  | { type: 'capture-started'; streamId: string }
  | { type: 'frame-result'; result: PipelineResult }
  | { type: 'status'; message: string }
  | { type: 'ping' };
