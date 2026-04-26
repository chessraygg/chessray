/**
 * Message types for service worker ⇄ offscreen doc ⇄ content script.
 *
 * All cross-context chatter flows through `chrome.runtime.sendMessage` /
 * `chrome.tabs.sendMessage`, which serializes everything as JSON. Anything
 * that can't round-trip through JSON (ImageData, MediaStream, ArrayBuffer)
 * must be transferred by reference (streamId) or sent over a dedicated port.
 */

import type { PipelineResult } from '@chessray/core';

/** Settings the panel can change at runtime. Mirrors the analogous IPC
 *  channels in the Electron preload. Offscreen owns the FrameProcessor so
 *  it's the one that has to apply each change. */
export type ExtensionSetting =
  | { key: 'multi-pv-max'; value: number }
  | { key: 'change-detect'; value: boolean }
  | { key: 'manual-flip'; value: boolean | null }
  | { key: 'target-fps'; value: number };

export type ExtensionMessage =
  | { type: 'start-capture'; tabId: number }
  | { type: 'stop-capture' }
  | { type: 'capture-started'; streamId: string }
  | { type: 'frame-result'; result: PipelineResult }
  | { type: 'apply-setting'; setting: ExtensionSetting }
  | { type: 'status'; message: string }
  | { type: 'ping' };
