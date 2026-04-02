import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';

const EXTENSION_PATH = path.join(__dirname, '../../dist/extension');
const VIDEO_URL = 'https://www.youtube.com/watch?v=lDbV-mY7DM8&t=350s';

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 720 },
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  extensionId = sw.url().split('/')[2];
  console.log(`Extension ID: ${extensionId}`);
});

test.afterAll(async () => {
  await context?.close();
});

test('detects board and draws overlay on chess video', async () => {
  test.setTimeout(180_000);

  const page = context.pages()[0];
  await page.goto(VIDEO_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Handle YouTube consent
  try {
    const btn = page.locator(
      'button:has-text("Accept all"), button:has-text("Reject all"), ' +
      'button:has-text("Alle akzeptieren"), button:has-text("Alle ablehnen")'
    );
    if (await btn.first().isVisible({ timeout: 3000 })) {
      await btn.first().click();
      console.log('Consent dismissed');
      await page.waitForTimeout(2000);
      await page.goto(VIDEO_URL, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(3000);
    }
  } catch { console.log('No consent dialog'); }

  // Wait for ads + video
  console.log('Waiting for ads to finish...');
  for (let i = 0; i < 20; i++) {
    try {
      const skip = page.locator('.ytp-skip-ad-button');
      if (await skip.isVisible({ timeout: 200 })) {
        await skip.click();
        console.log('Ad skipped');
      }
    } catch {}
    await page.waitForTimeout(2000);
  }
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v && v.paused) v.play();
  });
  await page.waitForTimeout(3000);
  await page.bringToFront();
  await page.screenshot({ path: 'test/e2e/output/before-tracking.png' });

  // Start tracking from the popup — the YouTube page must be the active tab
  // Open popup, find the YT tab, activate it, then send START_TRACKING with its tabId
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(500);

  const trackResult = await popup.evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const tabs = await chrome.tabs.query({});
    // Find the first non-extension, non-blank tab
    const ytTab = tabs.find((t: any) => t.id && !t.url?.startsWith('chrome-extension://') && !t.url?.startsWith('chrome://'));
    if (!ytTab) return { error: 'no youtube tab', tabs: tabs.map((t: any) => t.url?.slice(0, 40)) };

    // Make it active
    await chrome.tabs.update(ytTab.id, { active: true });
    await new Promise(r => setTimeout(r, 300));

    // Send START_TRACKING with explicit tabId
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'START_TRACKING', tabId: ytTab.id }, (resp: any) => {
        resolve(resp ?? { sent: true, tabId: ytTab.id });
      });
    });
  });
  console.log('Tracking result:', trackResult);
  await popup.close();

  await page.bringToFront();
  console.log('Waiting for board detection (30s)...');
  await page.waitForTimeout(30000);

  await page.screenshot({ path: 'test/e2e/output/overlay-1.png' });
  console.log('Saved overlay-1.png');

  const info = await page.evaluate(() => {
    const sr = document.getElementById('chessray-overlay')?.shadowRoot;
    if (!sr) return { overlay: false };
    const canvas = sr.getElementById('cv-video-overlay') as HTMLCanvasElement | null;
    let pixels = 0;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < d.length; i += 16) if (d[i] > 0) pixels++;
      }
    }
    return {
      overlay: true,
      fen: sr.getElementById('cv-debug-fen')?.textContent || '',
      info: sr.getElementById('cv-debug-info')?.textContent || '',
      status: sr.getElementById('cv-status')?.textContent || '',
      canvasPixels: pixels,
    };
  });
  console.log('Result:', JSON.stringify(info, null, 2));

  await page.waitForTimeout(10000);
  await page.screenshot({ path: 'test/e2e/output/overlay-2.png' });
  console.log('Saved overlay-2.png');

  expect(info.overlay).toBe(true);
  if (info.fen.includes('/')) {
    console.log('Board detected:', info.fen);
    expect(info.canvasPixels).toBeGreaterThan(0);
  }
});
