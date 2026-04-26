import type { ExtensionMessage } from '../shared/messages.js';

const statusEl = document.getElementById('status')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

/** Resolve which tab to capture. Production: the active tab in the window
 *  from which the popup was opened. Test harness: ?tabId=N override so the
 *  test can drive the click without depending on tab focus order across a
 *  popup-as-tab + content-tab pair. */
async function resolveTargetTabId(): Promise<number | null> {
  const params = new URLSearchParams(location.search);
  const override = params.get('tabId');
  if (override) return Number(override);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** Pull the tab MediaStream ID inside this user-gesture click handler.
 *  Chrome only grants tabCapture access when the call originates from a
 *  user-invoked extension surface (toolbar click → popup click handler).
 *  Calling this from the SW after an IPC hop loses that activation, which
 *  was the source of the "Extension has not been invoked for the current
 *  page" failures. */
function getStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'no stream id'));
        return;
      }
      resolve(id);
    });
  });
}

startBtn.addEventListener('click', async () => {
  const tabId = await resolveTargetTabId();
  if (!tabId) {
    setStatus('No active tab');
    return;
  }
  setStatus('Starting…');
  try {
    // Make Start idempotent: tear down any prior capture before grabbing
    // a fresh stream id, otherwise getMediaStreamId throws "Cannot capture
    // a tab with an active stream."
    await chrome.runtime.sendMessage({ type: 'stop-capture' } satisfies ExtensionMessage).catch(() => {});
    const streamId = await getStreamId(tabId);
    const msg: ExtensionMessage = { type: 'start-capture', tabId, streamId };
    const resp: { ok: boolean; error?: string } = await chrome.runtime.sendMessage(msg);
    setStatus(resp?.ok ? 'Running' : `Error: ${resp?.error ?? 'unknown'}`);
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`);
  }
});

stopBtn.addEventListener('click', async () => {
  const msg: ExtensionMessage = { type: 'stop-capture' };
  await chrome.runtime.sendMessage(msg);
  setStatus('Stopped');
});
