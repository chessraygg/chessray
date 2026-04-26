/**
 * Service worker: coordinates capture between the popup, the offscreen
 * document (pipeline + engine), and the content script (overlay).
 *
 * MV3 service workers are ephemeral — no persistent state here beyond what
 * lives in chrome.storage. The heavy lifting (Stockfish, ONNX, frame loop)
 * happens in the offscreen document, which stays alive as long as it has
 * active work.
 *
 * The popup grabs the tabCapture stream id itself (user-gesture context)
 * and hands the streamId here. We just open offscreen and forward.
 */

import type { ExtensionMessage } from '../shared/messages.js';

const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/offscreen.html');

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [
      chrome.offscreen.Reason.WORKERS,
      chrome.offscreen.Reason.USER_MEDIA,
    ],
    justification:
      'Runs Stockfish WASM worker + ONNX inference for live board recognition and evaluation.',
  });
}

/** Capture state persisted to chrome.storage.session so it survives
 *  SW restarts within the same browser session. The popup queries this
 *  on every open to show the real capture state — popups close on
 *  focus-loss (e.g. when Chrome's tab-share indicator appears) so the
 *  popup's local memory of "Starting…" or "Running" can be lost. */
type CaptureState = { running: boolean; tabId?: number };
async function getCaptureState(): Promise<CaptureState> {
  const { __chessrayCapture } = await chrome.storage.session.get('__chessrayCapture');
  return (__chessrayCapture as CaptureState | undefined) ?? { running: false };
}
async function setCaptureState(s: CaptureState): Promise<void> {
  await chrome.storage.session.set({ __chessrayCapture: s });
}

async function startCapture(tabId: number, streamId: string): Promise<void> {
  await ensureOffscreen();
  // Forward to offscreen. tabId rides along because offscreen documents
  // have no chrome.tabs access and need it to address the content script.
  const msg: ExtensionMessage = { type: 'capture-started', streamId, tabId };
  await chrome.runtime.sendMessage(msg);
  await setCaptureState({ running: true, tabId });
}

async function stopCapture(): Promise<void> {
  const msg: ExtensionMessage = { type: 'stop-capture' };
  await chrome.runtime.sendMessage(msg).catch(() => {});
  await setCaptureState({ running: false });
}

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg.type === 'start-capture') {
    startCapture(msg.tabId, msg.streamId).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true; // async response
  }
  if (msg.type === 'stop-capture') {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'get-capture-state') {
    getCaptureState().then(sendResponse);
    return true;
  }
  if (msg.type === 'get-target-tab') {
    (async () => {
      // Prefer the tab the user invoked the action on (activeTab grant
      // lives there). Fall back to chrome.storage.session in case the SW
      // was respawned between action click and panel query.
      if (lastInvokedTabId != null) {
        sendResponse({ tabId: lastInvokedTabId });
        return;
      }
      const stored = await chrome.storage.session.get('__chessrayInvokedTab').catch(() => ({}));
      const stashed = stored?.__chessrayInvokedTab as number | undefined;
      if (stashed != null) {
        lastInvokedTabId = stashed;
        sendResponse({ tabId: stashed });
        return;
      }
      sendResponse({ tabId: null });
    })();
    return true;
  }
  if (msg.type === 'ensure-offscreen') {
    // Test affordance: harness pings here so the offscreen doc exists
    // before it sends 'test-process-frame' directly to offscreen.
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }
  if (msg.type === 'forward-frame-result') {
    // Offscreen has no chrome.tabs / no broadcast access. We do both:
    //   - chrome.tabs.sendMessage → in-page panel (content script)
    //   - chrome.runtime.sendMessage → popup / side panel / any open
    //     extension surface that's subscribed
    const out: ExtensionMessage = { type: 'frame-result', result: msg.result };
    chrome.tabs.sendMessage(msg.tabId, out).catch(() => { /* page panel may be missing */ });
    chrome.runtime.sendMessage(out).catch(() => { /* no extension surface open */ });
    return false;
  }
  return false;
});

// Toolbar click → open the side panel via an explicit chrome.action
// .onClicked handler. We deliberately DON'T use
// sidePanel.setPanelBehavior({openPanelOnActionClick: true}) because
// that flag suppresses the onClicked event, and we want onClicked to
// fire — that's the canonical "user invoked the extension on this tab"
// signal Chrome uses to grant activeTab. Without that grant, the side
// panel's Start button hits "Extension has not been invoked" when it
// tries chrome.tabCapture.getMediaStreamId.
/** The tab activeTab was last granted on. Side-panel UI queries this so
 *  Start always targets the tab the user invoked the extension on, even
 *  if they've since switched tabs in the same window. */
let lastInvokedTabId: number | undefined;

// Crucial: do NOT call setPanelBehavior({openPanelOnActionClick: true}).
// That flag makes Chrome auto-open the panel on action click and
// SUPPRESSES chrome.action.onClicked entirely — and onClicked is the
// only event that grants activeTab. We need both: the panel to open AND
// onClicked to fire. The pattern that gives us both is:
//   - keep side_panel.default_path in manifest (so the panel exists)
//   - leave openPanelOnActionClick at default (false)
//   - open the panel ourselves from inside onClicked (which is allowed
//     because onClicked is a user gesture)

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  lastInvokedTabId = tab.id;
  await chrome.storage.session.set({ __chessrayInvokedTab: tab.id }).catch(() => {});
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error('[chessray] sidePanel.open:', err);
  }
});

// Also stamp lastInvokedTabId whenever the user activates a tab while
// the side panel is open. tabs.onActivated doesn't grant activeTab, but
// the data point lets the panel show "you're viewing tab X but invoked
// tab Y — click toolbar to grant capture for X" without confusion.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await chrome.storage.session.set({ __chessrayActiveTab: tabId }).catch(() => {});
});

// Keyboard shortcut path. Firing a chrome.commands shortcut counts as
// user-invocation per Chrome's docs (same class of grant as a toolbar
// click), so we get activeTab → tabCapture access from inside the SW
// without bouncing through the popup. Also makes the extension usable
// without ever opening the popup, which is friendlier for power users.
let captureRunning = false;
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-capture') return;
  if (captureRunning) {
    captureRunning = false;
    await stopCapture();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  try {
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'no stream id'));
          return;
        }
        resolve(id);
      });
    });
    captureRunning = true;
    await startCapture(tab.id, streamId);
  } catch (err) {
    console.error('[chessray] toggle-capture failed:', err);
  }
});
