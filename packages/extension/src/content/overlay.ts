/**
 * Content script: builds an extension-side ChessRayAPI implementation and
 * mounts the shared @chessray/overlay-ui panel into the active page.
 *
 * The same panel HTML, CSS, canvas-renderer and debug surface the Electron
 * app uses; only the IPC calls are different. Settings → offscreen via
 * chrome.runtime.sendMessage; frame results ← offscreen via tabs.sendMessage.
 *
 * Capabilities the extension can't honor (mouse-passthrough on a tab,
 * BrowserWindow recording, multi-monitor switching) are stubbed as no-ops
 * so the API surface stays total — mountOverlay can call any method
 * without `?.()` guards.
 */

import { mountOverlay, type ChessRayAPI, type DisplayInfo, type HostDisplay } from '@chessray/overlay-ui';
import type { ExtensionMessage, ExtensionSetting } from '../shared/messages.js';

type FrameResultListener = (result: unknown) => void;

const frameResultListeners: FrameResultListener[] = [];
const stopTrackingListeners: Array<() => void> = [];
const displayInfoListeners: Array<(info: DisplayInfo) => void> = [];

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type === 'frame-result') {
    const r = msg.result as { board_detection?: { found?: boolean }; arrows?: unknown[]; recognition?: { fen?: string } };
    console.log(`[chessray content] frame-result: found=${r.board_detection?.found} arrows=${r.arrows?.length ?? 0} fen=${r.recognition?.fen ?? '-'}`);
    for (const cb of frameResultListeners) cb(msg.result);
  }
});

function applySetting(setting: ExtensionSetting): void {
  const m: ExtensionMessage = { type: 'apply-setting', setting };
  // Service worker proxies → offscreen, but offscreen also accepts directly.
  chrome.runtime.sendMessage(m).catch(() => {});
}

function emitDisplayInfo(): void {
  const info: DisplayInfo = {
    scaleFactor: window.devicePixelRatio || 1,
    overlayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    displayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  };
  for (const cb of displayInfoListeners) cb(info);
}
window.addEventListener('resize', emitDisplayInfo);

const noop = (): void => { /* intentionally empty — capability not present in this host */ };

const bridge: ChessRayAPI = {
  // ── Capture lifecycle (analysis-side) ──
  // Content script doesn't run analysis; these are no-ops here. The
  // offscreen document handles capture; our service worker triggers it.
  onStartCapture: noop,
  onStopCapture: noop,
  sendRendererReady: noop,
  getSourceId: () => Promise.resolve(null),
  sendFrameResult: noop,
  sendDebugLog: (msg: string) => { console.log('[chessray]', msg); },

  // Frame results: subscribe to chrome.runtime messages.
  onFrameResult: (cb) => { frameResultListeners.push(cb); },
  onStopTracking: (cb) => { stopTrackingListeners.push(cb); },

  // ── Window/panel controls ──
  // Content overlay is pointer-events: none; passthrough is implicit.
  setMousePassthrough: noop,
  setAlwaysOnTop: noop,
  onDisplayInfo: (cb) => {
    displayInfoListeners.push(cb);
    // Push an initial value so the renderer has DPR/bounds before the
    // first resize event.
    cb({
      scaleFactor: window.devicePixelRatio || 1,
      overlayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      displayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    });
  },
  onSourceVisibility: (cb) => { cb(true); },

  // Source picker — no analog in tab-bound extension. Stub.
  getSources: () => Promise.resolve([]),
  selectSource: noop,
  reopenPicker: noop,

  // ── Engine settings → forward to offscreen ──
  setMultiPvMax: (n) => applySetting({ key: 'multi-pv-max', value: n }),
  onSetMultiPvMax: noop, // analysis-side; not used in content
  setChangeDetect: (enabled) => applySetting({ key: 'change-detect', value: enabled }),
  onSetChangeDetect: noop,
  setManualFlip: (v) => applySetting({ key: 'manual-flip', value: v }),
  onSetManualFlip: noop,
  setTargetFps: (fps) => applySetting({ key: 'target-fps', value: fps }),
  onSetTargetFps: noop,

  // ── Panel / system actions ──
  // The content panel handles these locally — no main-process roundtrip.
  onResetPanelPosition: noop,
  onTogglePanel: noop,
  onResetAllSettings: noop,
  requestResetPanelPosition: () => {
    const panel = document.getElementById('user-panel') as HTMLElement | null;
    if (panel) {
      panel.style.left = '20px';
      panel.style.top = '20px';
      panel.style.right = 'auto';
    }
  },
  requestResetAllSettings: () => {
    if (confirm('Reset all panel settings to defaults?')) {
      try { localStorage.removeItem('chessray-prefs'); } catch { /* ignore */ }
      location.reload();
    }
  },
  getDisplays: (): Promise<HostDisplay[]> => Promise.resolve([]),
  switchDisplay: noop,
  onDisplaysChanged: noop,

  // ── Frame recording — no fs in content script ──
  startRecording: noop,
  stopRecording: noop,
  onRecordingStateChanged: noop,
  saveFrameArtifact: noop,

  // ── Window/app controls ──
  minimizeApp: noop,
  closeApp: () => {
    const panel = document.getElementById('user-panel') as HTMLElement | null;
    if (panel) panel.style.display = 'none';
  },
  openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
  toggleLichess: (fen) => {
    const fenPath = encodeURIComponent(fen.split(' ')[0] ?? fen);
    window.open(`https://lichess.org/analysis/${fenPath}`, '_blank', 'noopener');
  },
  updateLichess: noop, // tab is detached; no live-sync
};

// Mount the overlay-ui but hide the floating panel — the popup is the
// canonical UI surface in the extension. The on-screen #video-overlay
// canvas stays visible (arrows + eval bar drawn on the captured page).
mountOverlay(bridge, { hidePanel: true });

// Notify the service worker that the content script is ready so it can
// trigger capture on user request.
chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {});
