/**
 * HostBridge — the abstraction over the embedding host (Electron, Chrome
 * extension, hypothetical web app). Both the analysis pipeline and the
 * overlay UI talk to the host through this interface, so the same code
 * runs in either environment with a different bridge implementation.
 *
 * Phase 0: interfaces only. No implementations yet — both hosts continue
 * to use their existing IPC bindings (window.chessRay in Electron,
 * chrome.runtime.* in the extension). Phases 2–6 progressively replace
 * those direct calls with `bridge.<method>` calls.
 *
 * Design rules:
 *  - Capture / engine bridges are mandatory (every host must support them).
 *  - Overlay / recorder / lichess bridges are optional — extensions don't
 *    have a draggable transparent panel, multi-display support, file I/O,
 *    or BrowserWindow-style auxiliary windows. Optional methods on those
 *    bridges are guarded with `?.()` at call sites.
 *  - Listener methods (`on*`) return an unsubscribe function so the
 *    overlay-ui module can clean up on unmount.
 */

import type { PipelineResult } from './shared/types.js';

export type Unsubscribe = () => void;

// ── Capture ────────────────────────────────────────────────────────────
// The analysis side asks the host to start/stop capture and receives a
// stream ID. The overlay side subscribes to frame results that the
// analysis side has produced.

export interface CaptureBridge {
  /** Returns the host-specific stream ID once a capture source is selected.
   *  Electron: a desktopCapturer source ID; extension: a tabCapture stream ID. */
  getSourceId(): Promise<string | null>;

  /** Analysis-side: receive a "begin capture with this source" command. */
  onStartCapture(cb: (sourceId: string) => void): Unsubscribe;

  /** Analysis-side: receive a "stop capture" command. */
  onStopCapture(cb: () => void): Unsubscribe;

  /** Analysis-side: signal that the renderer has finished initializing
   *  and is ready to receive the pending source ID (Electron-specific
   *  startup-race fix; safe to no-op in the extension). */
  sendRendererReady(): void;

  /** Analysis-side: emit a pipeline result for the overlay to render. */
  sendFrameResult(result: PipelineResult): void;

  /** Overlay-side: subscribe to pipeline results. */
  onFrameResult(cb: (result: PipelineResult) => void): Unsubscribe;

  /** Overlay-side: notified when the analysis side stops (source closed,
   *  capture revoked, etc.) so the overlay can clear its visuals. */
  onStopTracking(cb: () => void): Unsubscribe;

  /** Both sides: structured debug log (overlay forwards to console + file
   *  in Electron; just to console in the extension). */
  sendDebugLog(message: string): void;
}

// ── Engine settings ────────────────────────────────────────────────────
// Tunables that the overlay UI sets and the analysis pipeline applies.
// All listeners are analysis-side; setters are overlay-side.

export interface EngineBridge {
  setMultiPvMax(n: number): void;
  setManualFlip(value: boolean | null): void;
  setTargetFps(fps: number): void;

  onSetMultiPvMax(cb: (n: number) => void): Unsubscribe;
  onSetManualFlip(cb: (value: boolean | null) => void): Unsubscribe;
  onSetTargetFps(cb: (fps: number) => void): Unsubscribe;
}

// ── Overlay (host-window) controls ─────────────────────────────────────
// Everything that touches the host's *window* (Electron BrowserWindow
// or content-script viewport). Optional in the extension because a
// content script can't move/resize its host tab.

export interface OverlayBridge {
  /** Toggle whether mouse events on the on-screen overlay reach the
   *  underlying app (true = pass through; false = capture for the panel). */
  setMousePassthrough?(passthrough: boolean): void;

  /** Always-on-top toggle for the panel window. Electron-only. */
  setAlwaysOnTop?(enabled: boolean): void;

  /** Coordinate-mapping info: physical→CSS pixel ratio + window offset.
   *  Electron emits this on did-finish-load and on window move/resize.
   *  Extension may emit on devicePixelRatio changes (zoom). */
  onDisplayInfo?(cb: (info: DisplayInfo) => void): Unsubscribe;

  /** Source visibility — the captured app/window/tab is foreground? Used
   *  to hide the on-screen overlay when the source isn't visible. */
  onSourceVisibility?(cb: (visible: boolean) => void): Unsubscribe;

  /** Reset the panel's position to a known-good location. */
  requestResetPanelPosition?(): void;
  onResetPanelPosition?(cb: () => void): Unsubscribe;

  /** Wipe saved prefs and reload. The host shows the confirm dialog. */
  requestResetAllSettings?(): void;
  onResetAllSettings?(cb: () => void): Unsubscribe;

  /** Show/hide the user panel (separate from the on-screen overlay). */
  onTogglePanel?(cb: () => void): Unsubscribe;

  /** Multi-display switching (Electron-only; extensions are tab-bound). */
  getDisplays?(): Promise<HostDisplay[]>;
  switchDisplay?(id: number): void;
  onDisplaysChanged?(cb: () => void): Unsubscribe;
}

export interface DisplayInfo {
  scaleFactor: number;
  overlayBounds?: { x: number; y: number; width: number; height: number };
  displayBounds?: { x: number; y: number; width: number; height: number };
}

export interface HostDisplay {
  id: number;
  width: number;
  height: number;
  primary: boolean;
  activeId: number | null;
}

// ── Recorder (Electron-only) ───────────────────────────────────────────
// Writes raw captured frames to disk for test fixtures. The extension
// has no fs equivalent; this bridge is omitted in extension builds.

export interface RecorderBridge {
  startRecording(): void;
  stopRecording(): void;
  onRecordingStateChanged(cb: (active: boolean, sessionDir: string | null) => void): Unsubscribe;
  saveFrameArtifact(filename: string, data: Uint8Array): void;
}

// ── Lichess companion view ─────────────────────────────────────────────
// Electron opens a floating BrowserWindow; extension would call
// chrome.tabs.create. Both implement the same two methods.

export interface LichessBridge {
  toggle(fen: string, color: 'white' | 'black'): void;
  update(fen: string, color: 'white' | 'black'): void;
}

// ── Aggregate ──────────────────────────────────────────────────────────

export interface HostBridge {
  capture: CaptureBridge;
  engine: EngineBridge;
  overlay?: OverlayBridge;
  recorder?: RecorderBridge;
  lichess?: LichessBridge;
}
