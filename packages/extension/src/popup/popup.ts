import type { ExtensionMessage } from '../shared/messages.js';

const statusEl = document.getElementById('status')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;

function setStatus(s: string): void {
  statusEl.textContent = s;
}

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab');
    return;
  }
  setStatus('Starting…');
  const msg: ExtensionMessage = { type: 'start-capture', tabId: tab.id };
  const resp: { ok: boolean; error?: string } = await chrome.runtime.sendMessage(msg);
  setStatus(resp?.ok ? 'Running' : `Error: ${resp?.error ?? 'unknown'}`);
});

stopBtn.addEventListener('click', async () => {
  const msg: ExtensionMessage = { type: 'stop-capture' };
  await chrome.runtime.sendMessage(msg);
  setStatus('Stopped');
});
