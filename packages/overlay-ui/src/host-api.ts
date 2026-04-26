// ChessRayAPI — the surface area mountOverlay() needs from its host.
//
// The Electron preload's `typeof api` is structurally a superset of this
// interface; the extension's content-script bridge implements the same
// shape. Bridges that don't have a meaningful implementation for an entry
// (e.g. extension can't move tabs around → setMousePassthrough is a no-op)
// can stub the method but should still be present so the contract is
// total — that lets mountOverlay call any method without `?.()` guards.

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
  setChangeDetect: (enabled: boolean) => void;
  onSetChangeDetect: (cb: (enabled: boolean) => void) => void;
  setManualFlip: (v: boolean | null) => void;
  onSetManualFlip: (cb: (v: boolean | null) => void) => void;
  setTargetFps: (fps: number) => void;
  onSetTargetFps: (cb: (fps: number) => void) => void;

  // Panel/system actions
  onResetPanelPosition: (cb: () => void) => void;
  onTogglePanel: (cb: () => void) => void;
  onResetAllSettings: (cb: () => void) => void;
  requestResetPanelPosition: () => void;
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
}
