/**
 * Popup: hosts the full @chessray/overlay-ui panel. Same canvas-renderer,
 * eval bar, top-moves list, settings and diagnostics the Electron app
 * uses; the only popup-specific addition is the Start/Stop strip at the
 * top, since the extension can't auto-start (tabCapture needs a real
 * user-gesture grant from a popup click).
 *
 * Frame results arrive via chrome.runtime broadcast from the SW. The
 * content script's in-page panel still receives them too — both surfaces
 * stay in sync.
 */

import { mountOverlay, type ChessRayAPI, type DisplayInfo, type HostDisplay } from '@chessray/overlay-ui';
import type { ExtensionMessage, ExtensionSetting } from '../shared/messages.js';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('cap-status')!;

// ── Frame-result + display-info plumbing ───────────────────────────────
const frameResultListeners: Array<(r: unknown) => void> = [];
const displayInfoListeners: Array<(info: DisplayInfo) => void> = [];

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type === 'frame-result') {
    for (const cb of frameResultListeners) cb(msg.result);
  }
});

function applySetting(setting: ExtensionSetting): void {
  chrome.runtime.sendMessage({ type: 'apply-setting', setting } satisfies ExtensionMessage).catch(() => {});
}

const noop = (): void => { /* host doesn't support this method */ };

// Capture-lifecycle helpers wired to the existing service-worker flow.
async function startCaptureFromPopup(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { status.textContent = 'No active tab'; return; }
  status.textContent = 'Starting…';
  try {
    // Idempotent: tear down any previous stream first.
    await chrome.runtime.sendMessage({ type: 'stop-capture' } satisfies ExtensionMessage).catch(() => {});
    const streamId: string = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'no stream id'));
          return;
        }
        resolve(id);
      });
    });
    const resp: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({
      type: 'start-capture', tabId: tab.id, streamId,
    } satisfies ExtensionMessage);
    if (resp?.ok) {
      status.textContent = 'Running';
      startBtn.classList.add('running');
    } else {
      status.textContent = `Error: ${resp?.error ?? 'unknown'}`;
    }
  } catch (err) {
    status.textContent = `Error: ${(err as Error).message}`;
  }
}

async function stopCaptureFromPopup(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'stop-capture' } satisfies ExtensionMessage).catch(() => {});
  status.textContent = 'Stopped';
  startBtn.classList.remove('running');
}

startBtn.addEventListener('click', () => { void startCaptureFromPopup(); });
stopBtn.addEventListener('click', () => { void stopCaptureFromPopup(); });

// ── Bridge ─────────────────────────────────────────────────────────────
// Same shape as the content-script bridge — only differences are how
// frame-result arrives (broadcast vs tabs.sendMessage) and that the
// reset-panel-position handler scrolls within the popup body.

const bridge: ChessRayAPI = {
  onStartCapture: noop,
  onStopCapture: noop,
  sendRendererReady: noop,
  getSourceId: () => Promise.resolve(null),
  sendFrameResult: noop,
  sendDebugLog: (msg: string) => { console.log('[chessray]', msg); },

  onFrameResult: (cb) => { frameResultListeners.push(cb); },
  onStopTracking: noop,

  setMousePassthrough: noop,
  setAlwaysOnTop: noop,
  onDisplayInfo: (cb) => {
    displayInfoListeners.push(cb);
    cb({
      scaleFactor: window.devicePixelRatio || 1,
      overlayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      displayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    });
  },
  onSourceVisibility: (cb) => { cb(true); },

  getSources: () => Promise.resolve([]),
  selectSource: noop,
  reopenPicker: noop,

  setMultiPvMax: (n) => applySetting({ key: 'multi-pv-max', value: n }),
  onSetMultiPvMax: noop,
  setChangeDetect: (enabled) => applySetting({ key: 'change-detect', value: enabled }),
  onSetChangeDetect: noop,
  setManualFlip: (v) => applySetting({ key: 'manual-flip', value: v }),
  onSetManualFlip: noop,
  setTargetFps: (fps) => applySetting({ key: 'target-fps', value: fps }),
  onSetTargetFps: noop,

  onResetPanelPosition: noop,
  onTogglePanel: noop,
  onResetAllSettings: noop,
  requestResetPanelPosition: noop,
  requestResetAllSettings: () => {
    if (confirm('Reset all panel settings to defaults?')) {
      try { localStorage.removeItem('chessray-prefs'); } catch { /* ignore */ }
      location.reload();
    }
  },
  getDisplays: (): Promise<HostDisplay[]> => Promise.resolve([]),
  switchDisplay: noop,
  onDisplaysChanged: noop,

  startRecording: noop,
  stopRecording: noop,
  onRecordingStateChanged: noop,
  saveFrameArtifact: noop,

  minimizeApp: noop,
  closeApp: () => { window.close(); },
  openExternal: (url) => { chrome.tabs.create({ url }); },
  toggleLichess: (fen) => {
    const fenPath = encodeURIComponent(fen.split(' ')[0] ?? fen);
    chrome.tabs.create({ url: `https://lichess.org/analysis/${fenPath}` });
  },
  updateLichess: noop,
};

mountOverlay(bridge);
