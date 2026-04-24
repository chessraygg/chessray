/**
 * Wire the core vendor-URL resolver to `chrome.runtime.getURL(...)` so any
 * core module that needs a vendored asset (paddle-ocr model, future YOLO
 * weights loaded via vendorUrl) resolves to an extension-bundled file.
 *
 * Must run before any core code calls `vendorUrl()` — imported first by
 * `offscreen.ts`.
 */

import { setVendorResolver } from '@chessray/core';

setVendorResolver((rel) => chrome.runtime.getURL(`vendor/${rel}`));
