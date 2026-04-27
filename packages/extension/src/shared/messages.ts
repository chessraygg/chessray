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
  /** Popup → SW. The popup runs `chrome.tabCapture.getMediaStreamId` inside
   *  its click handler so the user-gesture activeTab grant comes from the
   *  real popup invocation; the SW just opens offscreen and forwards. */
  | { type: 'start-capture'; tabId: number; streamId: string }
  | { type: 'stop-capture' }
  /** SW → offscreen. `viewport` is the target tab's content area in
   *  *physical pixels* (CSS px × devicePixelRatio) at capture-start time.
   *  Offscreen pins getUserMedia min=max to these values so Chrome
   *  doesn't downscale-with-letterboxing — the captured frame then maps
   *  cleanly to the viewport. Optional because some entry points (the
   *  test harness) don't measure it. */
  | { type: 'capture-started'; streamId: string; tabId: number; viewport?: { width: number; height: number } }
  /** Test-only: SW grabs a single frame via chrome.tabs.captureVisibleTab
   *  (works without activeTab thanks to <all_urls> host_permissions) and
   *  hands the dataURL to offscreen. Used by scripts/local/test-extension
   *  to exercise the full pipeline end-to-end without the user-gesture
   *  wall around tabCapture.getMediaStreamId. */
  | { type: 'ensure-offscreen' }
  | { type: 'test-process-frame'; tabId: number; dataUrl: string }
  | { type: 'frame-result'; result: PipelineResult }
  | { type: 'apply-setting'; setting: ExtensionSetting }
  /** Offscreen → SW: please forward this frame-result to the content
   *  script in `tabId` (offscreen has no chrome.tabs access; SW does). */
  | { type: 'forward-frame-result'; tabId: number; result: PipelineResult }
  /** Popup ⇄ SW: query/persist whether a capture is currently running.
   *  Popups close on focus-loss (e.g. when Chrome shows the tab-share
   *  indicator), so the popup can't trust local state alone — it asks
   *  the SW on every open. */
  | { type: 'get-capture-state' }
  | { type: 'get-trace' }
  /** Side panel → content script: a chessray pref changed in the panel,
   *  apply the same value over here so the on-page overlay stays in
   *  sync. Both surfaces store prefs in their own localStorage; this
   *  bridges them. */
  | { type: 'prefs-update'; prefs: Record<string, unknown> }
  /** Side panel ⇄ SW: which tab was activeTab-granted (i.e. the one
   *  the user clicked the toolbar action on). Side panel uses this
   *  instead of its own chrome.tabs.query so Start always targets the
   *  tab Chrome will let us capture, even if focus has since moved. */
  | { type: 'get-target-tab' }
  | { type: 'status'; message: string }
  | { type: 'ping' }
  /** Content script → offscreen (broadcast). The captured tab's
   *  content area resized (window resize, side panel open/close, OS
   *  chrome change). Offscreen calls track.applyConstraints to resize
   *  the existing MediaStreamTrack — we can NOT call
   *  chrome.tabCapture.getMediaStreamId from the SW here because that
   *  requires a fresh user gesture (per Chrome DevRel: "It isn't
   *  possible to do this without a user gesture unfortunately"). */
  | { type: 'viewport-resized'; viewport: { width: number; height: number } }
  /** Offscreen → SW. Offscreen has no access to the SW's trace ring
   *  buffer (the surface the side panel reads from), so it forwards
   *  diagnostics here for visibility without requiring DevTools. */
  | { type: 'log-from-offscreen'; message: string };
