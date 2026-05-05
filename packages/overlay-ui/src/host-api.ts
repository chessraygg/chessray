// ChessRayAPI — the surface area mountOverlay() needs from its host.
//
// The Electron preload's `typeof api` is structurally a superset of this
// interface; the extension's content-script bridge implements the same
// shape. Bridges that don't have a meaningful implementation for an entry
// (e.g. extension can't move tabs around → setMousePassthrough is a no-op)
// can stub the method but should still be present so the contract is
// total — that lets mountOverlay call any method without `?.()` guards.

/** PV control actions broadcast across surfaces so the panel's virtual
 *  board and the on-page video overlay stay in sync. Single-document
 *  hosts (Electron) can no-op the broadcast/listener pair — both
 *  surfaces share state directly there. Cross-context hosts (extension:
 *  popup ↔ content script) round-trip through the SW. */
export type PvAction =
  | { kind: 'trigger-line'; lineIndex: number }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'jump-to'; depth: number }
  | { kind: 'stop' };

export interface DisplayInfo {
  scaleFactor: number;
  size?: { width: number; height: number };
  workArea?: { x: number; y: number; width: number; height: number };
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

export interface ChessRayAPI {
  // Capture lifecycle (analysis-side; overlay only uses the *receiver* half)
  onStartCapture: (cb: (sourceId: string) => void) => void;
  onStopCapture: (cb: () => void) => void;
  sendRendererReady: () => void;
  getSourceId: () => Promise<string | null>;
  sendFrameResult: (result: unknown) => void;
  sendDebugLog: (msg: string) => void;
  onFrameResult: (cb: (result: unknown) => void) => void;
  onStopTracking: (cb: () => void) => void;

  // Window/panel controls
  setMousePassthrough: (passthrough: boolean) => void;
  setAlwaysOnTop: (enabled: boolean) => void;
  onDisplayInfo: (cb: (info: DisplayInfo) => void) => void;
  onSourceVisibility: (cb: (visible: boolean) => void) => void;

  // Capture source picker
  getSources: () => Promise<unknown[]>;
  selectSource: (id: string) => void;
  reopenPicker: () => void;

  // Engine settings
  setMultiPvMax: (n: number) => void;
  onSetMultiPvMax: (cb: (n: number) => void) => void;
  setManualFlip: (v: boolean | null) => void;
  onSetManualFlip: (cb: (v: boolean | null) => void) => void;
  setTargetFps: (fps: number) => void;
  onSetTargetFps: (cb: (fps: number) => void) => void;

  // Panel/system actions
  onTogglePanel: (cb: () => void) => void;
  onResetAllSettings: (cb: () => void) => void;
  requestResetAllSettings: () => void;
  getDisplays: () => Promise<HostDisplay[]>;
  switchDisplay: (id: number) => void;
  onDisplaysChanged: (cb: () => void) => void;

  // Frame recording (electron-only; extension stubs as no-op)
  startRecording: () => void;
  stopRecording: () => void;
  onRecordingStateChanged: (cb: (active: boolean, sessionDir: string | null) => void) => void;
  saveFrameArtifact: (filename: string, buf: Uint8Array) => void;

  // Window/app controls
  minimizeApp: () => void;
  closeApp: () => void;
  openExternal: (url: string) => void;
  toggleLichess: (fen: string, color: string) => void;
  updateLichess: (fen: string, color: string) => void;

  // PV control sync (cross-surface broadcast). Only meaningful in the
  // extension where popup + content script have isolated state; Electron
  // can leave both as no-ops since both surfaces share one document.
  broadcastPvAction: (action: PvAction) => void;
  onPvAction: (cb: (action: PvAction) => void) => void;

  /** User clicked the "Start capture" affordance inside the empty panel.
   *  Each host wires this to its native start-capture flow:
   *    - Extension side panel: sync chrome.tabCapture.getMediaStreamId
   *      (must run from the click's user-gesture context) then send the
   *      streamId to the SW so it can spin up the offscreen recorder.
   *    - Electron: open the source picker / re-fire selectSource.
   *  Default is a no-op so hosts that don't expose this affordance don't
   *  break the bridge. */
  requestStartCapture: () => void;
}

/**
 * Build a ChessRayAPI from a partial set of host implementations, filling
 * the gaps with safe no-op defaults. Hosts that can't honor a capability
 * (e.g. the extension can't toggle mouse passthrough on a tab) just omit
 * those keys; the helper supplies stubs.
 *
 * Why this exists: ChessRayAPI is ~35 methods, and previously every host
 * — popup, content script — re-declared `noop = () => {}` and wired ~25
 * stubs by hand. When the interface grew, those wrappers fell out of sync
 * silently because TypeScript's structural typing accepted under-typed
 * objects. Funnelling through `createDefaultBridge` means TS only has to
 * verify that the *helper* covers every key, and adding a new method
 * automatically gets a default for hosts that don't override it.
 */
export function createDefaultBridge(overrides: Partial<ChessRayAPI> = {}): ChessRayAPI {
  const noop = (): void => { /* host doesn't support this method */ };
  const defaults: ChessRayAPI = {
    onStartCapture: noop,
    onStopCapture: noop,
    sendRendererReady: noop,
    getSourceId: () => Promise.resolve(null),
    sendFrameResult: noop,
    sendDebugLog: noop,
    onFrameResult: noop,
    onStopTracking: noop,

    setMousePassthrough: noop,
    setAlwaysOnTop: noop,
    onDisplayInfo: noop,
    onSourceVisibility: (cb: (visible: boolean) => void) => { cb(true); },

    getSources: () => Promise.resolve([]),
    selectSource: noop,
    reopenPicker: noop,

    setMultiPvMax: noop,
    onSetMultiPvMax: noop,
    setManualFlip: noop,
    onSetManualFlip: noop,
    setTargetFps: noop,
    onSetTargetFps: noop,

    onTogglePanel: noop,
    onResetAllSettings: noop,
    requestResetAllSettings: noop,
    getDisplays: () => Promise.resolve([]),
    switchDisplay: noop,
    onDisplaysChanged: noop,

    startRecording: noop,
    stopRecording: noop,
    onRecordingStateChanged: noop,
    saveFrameArtifact: noop,

    minimizeApp: noop,
    closeApp: noop,
    openExternal: noop,
    toggleLichess: noop,
    updateLichess: noop,

    broadcastPvAction: noop,
    onPvAction: noop,

    requestStartCapture: noop,
  };
  return { ...defaults, ...overrides };
}
