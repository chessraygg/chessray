# Chrome Web Store — Listing Copy & Permission Justifications

Copy/paste-ready text for the Web Store developer console
(`https://chrome.google.com/webstore/devconsole`). Fields are grouped
by the dashboard section they belong to.

---

## Store listing → Product details

### Name
```
Chessray
```

### Summary (≤132 chars)
```
Stockfish evaluation overlay for chess streams, videos, replays and screenshots. Local-only. Excludes chess.com / lichess.org.
```

### Detailed description
```
Chessray turns any chess board on your screen into a live analysis board.

It captures the current tab, finds the chess board using on-device computer vision (YOLOv11), recognizes every piece, figures out which side is to move, and runs Stockfish 18 right inside the browser. The best moves, evaluation, and principal variation appear in a side panel and as an overlay drawn on top of the board itself — arrows, eval bar, and a small preview board for the engine's planned line.

Works with anything visible:
• Twitch and YouTube chess streams
• video files and PDF viewers in the browser
• screenshots and images
• replays, studies, and analysis pages on other chess platforms

Chessray does NOT run on chess.com or lichess.org. The extension hard-refuses to start capture on those hosts and the on-page overlay never injects there — running engine analysis on a live game on either site would violate their anti-cheat policies, and Chessray is built for streams, videos, and study material, not live play.

Everything runs locally. No account, no sign-up, no data leaves your computer. The Stockfish engine and all recognition models are bundled with the extension — no network calls during analysis.

Features:
• Live board recognition from screen pixels (no DOM scraping, no site integrations)
• Stockfish 18 Lite (WASM) with iterative deepening and multi-PV
• On-page overlay with arrows, eval bar, and a PV preview board
• Side panel with full analysis, move list, and a one-click "Open in Lichess Analysis" button
• Keyboard shortcut (Cmd/Ctrl+Shift+M) to start/stop capture without touching the toolbar
• Customizable: overlay size, opacity, what to show, panel layout

Privacy: Chessray does not transmit pixels, recognized positions, evaluations, or any other data off your device. See the privacy policy for full details.

Open source under GPL-3.0:
https://github.com/chessraygg/chessray
```

### Category
```
Productivity
```
(Secondary suggestion: "Fun" if Productivity is rejected.)

### Language
```
English
```

---

## Privacy practices

### Single-purpose description
```
Chessray recognizes chess positions visible in the current browser tab using on-device computer vision and overlays the engine analysis on top of the board.
```

### Permission justifications

Paste these into the corresponding text boxes in the **Privacy practices**
section of the dashboard.

**`tabCapture`**
```
Required to capture the active tab's pixels. The vision pipeline reads each captured frame, finds the chess board, recognizes the pieces, and discards the frame from memory. Without tabCapture the extension cannot see the board at all.
```

**`offscreen`**
```
Stockfish (WASM) and ONNX-runtime inference must run on a long-lived document with a DOM. The MV3 service worker is ephemeral and cannot host them. The offscreen document loads only extension-bundled assets — no network code.
```

**`scripting`**
```
Used to (1) inject the on-page overlay (arrows, eval bar, PV board) into the captured tab and (2) read the tab's content-area size so the overlay aligns 1:1 with the captured frame. No page content is read or modified.
```

**`storage`**
```
Persists user preferences (overlay opacity, side-panel layout, last-known capture state) in chrome.storage on the local device. No user identity or telemetry is stored.
```

**`sidePanel`**
```
The Chessray analysis UI (board view, eval, move list, settings) lives in Chrome's side panel. The sidePanel permission is required to open it programmatically when the user clicks the toolbar button or uses the keyboard shortcut.
```

**`contextMenus`**
```
Provides a right-click "Chessray: Capture this tab" entry. Some Chrome versions suppress the toolbar action click when a side panel is configured; the context menu is a reliable fallback for invoking capture with a user gesture.
```

**Host permission: `<all_urls>`**
```
The on-page overlay is a content script that draws arrows, an eval bar, and a PV preview board on top of the captured board. The user may invoke Chessray on any site that happens to show a chess board (Twitch / YouTube streams, image viewers, PDF readers, screenshots, replay / study pages, archived games), so the script's match pattern cannot be narrowed to a fixed allowlist without breaking the long tail of sites where the feature is useful. No site is read or modified — the overlay is drawn into a top-level container; no page DOM is queried. chess.com and lichess.org are excluded explicitly: content_scripts.exclude_matches in the manifest prevents the overlay from ever injecting on those hosts, and a service-worker guard refuses to start tabCapture on those hosts from every invocation path (toolbar click, keyboard shortcut, context menu, side-panel CTA). The extension cannot be used to assist live games on either platform.
```

### Data usage disclosure (checkbox guidance)

In the **"What user data will your extension collect or use?"** section,
mark **all checkboxes as "No"** EXCEPT:

- **Website content** — _check_ → "This extension reads website content via tab capture (pixels only) for local analysis. Data is not transmitted off the device."

Tick the three certification checkboxes at the bottom:
- I do not sell or transfer user data to third parties …
- I do not use or transfer user data for purposes unrelated to the item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
https://github.com/chessraygg/chessray/blob/main/docs/chrome-webstore/privacy-policy.md
```

(Or wherever the privacy policy ends up hosted — must be a publicly reachable URL.)

---

## Visual assets to prepare

These are NOT in the repo and must be produced before submission.

| Asset | Size | Required? | Notes |
| ----- | ---- | --------- | ----- |
| Extension icon | 128×128 px | ✓ already in repo | `packages/extension/src/icons/icon-128.png` |
| Screenshots | 1280×800 or 640×400 px | ✓ at least 1, up to 5 | Show Chessray analyzing a real board on a supported surface (Twitch chess stream, YouTube replay, lichess study page, agadmator video, PDF, screenshot). DO NOT use chess.com or a live lichess.org game — those hosts are blocklisted and reviewers will catch a screenshot that contradicts the blocklist claim. At least one screenshot should show the side panel + overlay together. |
| Small promo tile | 440×280 px | ✓ required | Used in search results and category pages. |
| Marquee promo tile | 1400×560 px | optional | Required if you want featuring eligibility. |

Tip: take screenshots at exactly 1280×800 by setting the Chrome window to
that size; reviewers reject scaled / stretched captures.

---

## Submission checklist

- [ ] Production zip built via `npm run build:webstore -w packages/extension`
- [ ] Privacy policy URL is publicly reachable (200 OK, not behind login)
- [ ] All permission justifications pasted from this file
- [ ] Single-purpose description set
- [ ] Data usage disclosure complete + certified
- [ ] At least 1 screenshot at 1280×800
- [ ] Small promo tile 440×280 uploaded
- [ ] `manifest.json` in zip has no `localhost` references and no wildcard `web_accessible_resources`
- [ ] Version number in `packages/extension/package.json` bumped if this is not the first submission
