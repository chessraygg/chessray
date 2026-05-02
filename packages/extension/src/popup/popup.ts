/**
 * Popup: hosts the full @chessray/overlay-ui panel. Same canvas-renderer,
 * eval bar, top-moves list, settings and diagnostics the Electron app
 * uses. Capture start/stop is driven by the toolbar icon
 * (chrome.action.onClicked → service-worker), not from this popup —
 * the popup just preloads the target tab id so pref changes here can
 * be relayed to the captured tab's content script.
 */

import { mountOverlay, createDefaultBridge, type ChessRayAPI, type DisplayInfo } from '@chessray/overlay-ui';
import type { ExtensionMessage, ExtensionSetting } from '../shared/messages.js';
// Popup owns its document, so it can safely load panel.css's global
// rules. (mount-overlay.ts no longer pulls panel.css automatically —
// that was leaking body{overflow:hidden} into every page the content
// script ran on.)
import '@chessray/overlay-ui/src/panel.css';
import './popup.css';

// ── Pre-resolve target tabId at popup load ──────────────────────────
// Used by the localStorage→content-script pref relay below so the
// captured tab's overlay re-renders when the user toggles things in
// the popup. Falls back from sw-target → currentWindow → lastFocused
// → any so the relay works even when the popup is opened in odd ways
// (test harness paths, side-panel re-open after capture stopped).
let cachedTabId: number | null = null;
async function preloadTabId(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const override = params.get('tabId');
  if (override) {
    cachedTabId = Number(override);
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-target-tab' } satisfies ExtensionMessage);
    if (resp?.tabId != null) {
      cachedTabId = resp.tabId;
      return;
    }
  } catch { /* SW unreachable; fall through */ }
  const isContent = (t: chrome.tabs.Tab | undefined): boolean =>
    !!t?.url && (t.url.startsWith('http://') || t.url.startsWith('https://'));
  const queries: chrome.tabs.QueryInfo[] = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { currentWindow: true },
    {},
  ];
  for (const q of queries) {
    const tabs = await chrome.tabs.query(q);
    const t = tabs.find(isContent);
    if (t) {
      cachedTabId = t.id ?? null;
      return;
    }
  }
  cachedTabId = null;
}
void preloadTabId();

// When the SW updates the invoked tab id (i.e., the user clicks the
// toolbar icon and the side panel rehydrates onto a new tab), refresh
// the cached tab id so subsequent pref changes go to the right tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if ('__chessrayInvokedTab' in changes) void preloadTabId();
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

// ── Bridge ─────────────────────────────────────────────────────────────

const bridge: ChessRayAPI = createDefaultBridge({
  sendDebugLog: (msg: string) => { console.log('[chessray]', msg); },

  onFrameResult: (cb) => { frameResultListeners.push(cb); },

  onDisplayInfo: (cb) => {
    displayInfoListeners.push(cb);
    cb({
      scaleFactor: window.devicePixelRatio || 1,
      overlayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      displayBounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    });
  },

  setMultiPvMax: (n) => applySetting({ key: 'multi-pv-max', value: n }),
  setManualFlip: (v) => applySetting({ key: 'manual-flip', value: v }),
  setTargetFps: (fps) => applySetting({ key: 'target-fps', value: fps }),

  requestResetAllSettings: () => {
    if (confirm('Reset all panel settings to defaults?')) {
      try { localStorage.removeItem('chessray-prefs'); } catch { /* ignore */ }
      location.reload();
    }
  },

  closeApp: () => { window.close(); },
  openExternal: (url) => { chrome.tabs.create({ url }); },
  toggleLichess: (fen, color) => {
    // Match the Electron path: pass the *full* FEN with spaces → underscores
    // so Lichess parses side-to-move, castling, etc. Position-only FENs
    // silently render the starting position.
    const fenPath = fen.replace(/ /g, '_');
    const side = color === 'black' ? 'black' : 'white';
    chrome.tabs.create({ url: `https://lichess.org/analysis/${fenPath}?color=${side}` });
  },

  // PV control sync: popup ↔ content script. Each surface broadcasts its
  // own user-initiated PV actions; the SW relays popup→content via
  // chrome.tabs.sendMessage, content→popup auto-broadcasts via runtime.
  broadcastPvAction: (action) => {
    chrome.runtime.sendMessage({ type: 'pv-action', action, from: 'popup' } satisfies ExtensionMessage)
      .catch(() => {});
  },
  onPvAction: (cb) => {
    chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
      if (msg?.type === 'pv-action' && msg.from === 'content') cb(msg.action);
    });
  },
});

mountOverlay(bridge);

// ── Engine info in Diagnostics ────────────────────────────────────────
// Inject a small "Engine" line at the top of the diagnostics view
// surfacing the YOLO ONNX execution provider (webgpu vs wasm) and
// recent applyConstraints results — both come from the SW trace,
// which is populated by debugLog() in offscreen. The trace lives in
// the SW only; pull it on bootstrap and on a 2s interval so the side
// panel always shows fresh values without DevTools.
function ensureEngineInfoEl(): HTMLElement | null {
  let el = document.getElementById('cv-engine-info') as HTMLElement | null;
  if (el) return el;
  const debugSection = document.getElementById('debug-section');
  if (!debugSection) return null;
  el = document.createElement('div');
  el.id = 'cv-engine-info';
  // Append at the BOTTOM of the diagnostics view — it's reference info,
  // not the primary thing the user is looking at. Styled in popup.css.
  el.textContent = 'Engine info: loading…';
  debugSection.appendChild(el);
  return el;
}

function renderEngineInfo(info: { yolo?: string; stream?: string; constraints?: string } | null): void {
  const el = ensureEngineInfoEl();
  if (!el) return;
  if (!info) { el.textContent = 'Engine info: loading…'; return; }
  const parts: string[] = [];
  if (info.yolo) parts.push(info.yolo);
  if (info.stream) parts.push(info.stream);
  if (info.constraints) parts.push(info.constraints);
  el.textContent = parts.length ? parts.join('\n') : 'Engine info: capture not started';
}

async function refreshEngineInfo(): Promise<void> {
  // Direct query to offscreen. SW also receives the message but has no
  // handler for it, so offscreen's response wins. If offscreen isn't
  // up yet (capture never started this session), the message rejects
  // and we surface that.
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-engine-info' } satisfies ExtensionMessage);
    renderEngineInfo(resp?.info ?? null);
  } catch {
    const el = ensureEngineInfoEl();
    if (el) el.textContent = 'Engine info: offscreen not running (start capture)';
  }
}
void refreshEngineInfo();

// Live updates: offscreen broadcasts engine-info-update on every change.
chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type === 'engine-info-update') renderEngineInfo(msg.info);
});

// Belt-and-braces: also poll every 3s in case a broadcast was missed
// (e.g. side panel opened mid-flight before the YOLO load fired).
setInterval(refreshEngineInfo, 3000);

// Relay pref changes to the captured tab's content script so the on-page
// overlay (border/box, arrow opacity/size, eval-bar opacity, etc.) keeps
// up with what the user just toggled in the side panel. Side panel and
// content script each have their own localStorage; without this bridge,
// every setting only takes effect inside the (hidden) side-panel canvas.
const origSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = (key: string, value: string): void => {
  origSetItem(key, value);
  if (key !== 'chessray-prefs' || cachedTabId == null) return;
  try {
    const prefs = JSON.parse(value) as Record<string, unknown>;
    void chrome.tabs.sendMessage(cachedTabId, {
      type: 'prefs-update', prefs,
    } satisfies ExtensionMessage).catch(() => { /* content script may be missing */ });
  } catch { /* ignore parse errors */ }
};
