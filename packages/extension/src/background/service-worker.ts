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

async function startCapture(tabId: number, streamId: string): Promise<void> {
  await ensureOffscreen();
  // Forward to offscreen. tabId rides along because offscreen documents
  // have no chrome.tabs access and need it to address the content script.
  const msg: ExtensionMessage = { type: 'capture-started', streamId, tabId };
  await chrome.runtime.sendMessage(msg);
}

async function stopCapture(): Promise<void> {
  const msg: ExtensionMessage = { type: 'stop-capture' };
  await chrome.runtime.sendMessage(msg).catch(() => {});
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
