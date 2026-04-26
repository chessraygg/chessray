/**
 * Popup: hosts the full @chessray/overlay-ui panel. Same canvas-renderer,
 * eval bar, top-moves list, settings and diagnostics the Electron app
 * uses; the only popup-specific addition is the Start/Stop strip at the
 * top, since the extension can't auto-start (tabCapture needs a popup
 * user-gesture grant).
 *
 * IMPORTANT: chrome.tabCapture.getMediaStreamId requires the user
 * activation to still be fresh at call time. ANY `await` between the
 * click event and getMediaStreamId can consume the activation and the
 * call fails with "Extension has not been invoked for the current
 * page (see activeTab permission). Chrome pages cannot be captured."
 *
 * The fix below: resolve tabId at popup load and call getMediaStreamId
 * synchronously from the click handler; only await after the streamId
 * is in hand.
 */

import { mountOverlay, type ChessRayAPI, type DisplayInfo, type HostDisplay } from '@chessray/overlay-ui';
import type { ExtensionMessage, ExtensionSetting } from '../shared/messages.js';
// Popup CSS imported AFTER mountOverlay (which pulls in panel.css from
// overlay-ui) so this file's selectors win on equal-specificity rules
// — body background, panel positioning, etc.
import './popup.css';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('cap-status')!;

// ── Pre-resolve target tabId at popup load ──────────────────────────
//   Done off the click path so awaiting tabs.query doesn't consume the
//   user gesture later. Falls back from currentWindow → lastFocusedWindow
//   so the popup also works when opened as a tab (test harness path).
let cachedTabId: number | null = null;
async function preloadTabId(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const override = params.get('tabId');
  if (override) { cachedTabId = Number(override); return; }
  // Only http(s) tabs are real captureable content. In production the
  // popup-from-toolbar makes currentWindow's active tab the user's tab.
  // In test (popup-as-tab) the popup itself is active in its window, so
  // fall back to any http(s) tab in the same window or any http(s) tab
  // anywhere.
  const isContent = (t: chrome.tabs.Tab | undefined): boolean =>
    !!t?.url && (t.url.startsWith('http://') || t.url.startsWith('https://'));
  const queries: Array<chrome.tabs.QueryInfo> = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { currentWindow: true },
    {},
  ];
  for (const q of queries) {
    const tabs = await chrome.tabs.query(q);
    const t = tabs.find(isContent);
    if (t) { cachedTabId = t.id ?? null; return; }
  }
  cachedTabId = null;
}

// Disable Start until tabId is resolved so a fast click doesn't race
// against the (very short) preload and silently fail with "No active
// tab". Stop is always safe.
startBtn.disabled = true;
status.textContent = '…';
preloadTabId().then(() => {
  startBtn.disabled = false;
  status.textContent = cachedTabId === null ? 'No http(s) tab to capture' : 'Idle';
});

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

// ── Capture lifecycle ─────────────────────────────────────────────────
//
// Sync call into chrome.tabCapture.getMediaStreamId is critical: any
// preceding await consumes the user-gesture activation and the call
// fails with the activeTab error. Tab id is already cached.

startBtn.addEventListener('click', () => {
  if (cachedTabId === null) {
    status.textContent = 'No active tab';
    // Try to recover for next click.
    void preloadTabId();
    return;
  }
  const tabId = cachedTabId;
  status.textContent = 'Starting…';
  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      const msg = chrome.runtime.lastError?.message ?? 'no stream id';
      // The "active stream" error means a previous capture is still alive
      // on this tab. We can't tear it down + retry inside the same click
      // (the retry would have no user activation), so we surface a clear
      // recovery hint and ask the user to press Stop first.
      if (msg.includes('active stream')) {
        status.textContent = 'Already capturing — click Stop, then Start again';
      } else {
        status.textContent = `Error: ${msg}`;
      }
      return;
    }
    // Past the user-gesture-gated call now; safe to await.
    void (async () => {
      try {
        const resp: { ok: boolean; error?: string } = await chrome.runtime.sendMessage({
          type: 'start-capture', tabId, streamId,
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
    })();
  });
});

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop-capture' } satisfies ExtensionMessage).catch(() => {});
  status.textContent = 'Stopped';
  startBtn.classList.remove('running');
});

// ── Bridge ─────────────────────────────────────────────────────────────

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
