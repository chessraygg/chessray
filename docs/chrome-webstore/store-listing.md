# Chrome Web Store — Dashboard Field Reference

Copy/paste-ready text for every field in the developer console
(<https://chrome.google.com/webstore/devconsole>). Sections below mirror
the dashboard sidebar tabs in the order they appear, and the field order
within each tab matches the live form. Field names are quoted exactly as
the dashboard labels them.

---

## Package (auto-uploaded from zip — read-only in dashboard)

These come from `manifest.json` (built by `npm run build:webstore`) and
cannot be edited in the dashboard. Listed so the "from package" labels on
the Store listing tab make sense.

| Dashboard label | Source |
| --- | --- |
| Title (from package) | manifest `name` → `"Chessray"` |
| Summary (from package) | manifest `description` → the 122-char tagline |
| Version | manifest `version` → latest `v*` git tag (e.g., `0.2.87`) |

To regenerate the zip with the latest tag: `npm run build:webstore`. The
upload artifact is `releases/chessray-v<version>.zip`.

---

## Store listing → Product details

### Title (from package, read-only)
```
Chessray
```

### Summary (from package, read-only)
```
Chess companion that draws and updates top moves + an eval bar on any chess video or stream as it plays. No manual scans.
```

### Description (0/16,000 chars — manually entered)
```
Chessray is a chess companion for streams, videos, replays, screenshots, and PDFs. It watches the chess board in your tab and draws Stockfish's best moves directly on top of it — arrows on the source/destination squares and an evaluation bar down one side.

It's built for content you watch, not games you play:
• YouTube chess channels — agadmator, GothamChess, Hanging Pawns, Eric Rosen
• Twitch chess streams — Hikaru, BotezLive, chessbrah
• Replays and study pages on chess platforms
• Chess books open as PDFs in the browser
• Screenshots and image viewers

Features:
• Live tracking — as the chess board on screen changes (next move in the video, scrubbing back, a new puzzle), Chessray re-analyzes within ~1 second.
• Color-coded top-move arrows — the engine's best moves drawn directly on the source/destination squares, color-coded so you can tell the first choice from second / third options at a glance.
• Live evaluation bar — numeric eval painted alongside the board, updated continuously as moves happen.
• Auto last-move + turn detection — Chessray finds the highlighted squares the chess UI draws after each move and uses them to infer both the last move played AND whose turn it is. A manual board-flip toggle in the side panel is there as a fallback when auto-orientation gets it wrong.
• Variation preview — click any top-move arrow and the on-page board is replaced with a virtual board that plays through the engine's principal variation move-by-move. One click returns to the live board.
• Adjustable overlay — change arrow size, change overlay opacity, or hide move hints entirely.
• Works on any site — pure pixel-based recognition (YOLOv11), no DOM scraping, no site-specific integration. Streams, replays, PDFs, screenshots all work the same way.
• Stockfish 18 Lite (WASM) — iterative deepening + multi-PV, all bundled and running on-device. No network calls.
• Side panel with detailed analysis (reachable via right-click on the toolbar icon → Open side panel).
• Keyboard shortcut to start/stop capture (rebindable at chrome://extensions/shortcuts).

How it's different from scan-on-demand extensions: no Scan button, no popup window, no jumping to an external analysis page. The overlay paints in place on the captured tab and updates continuously as moves happen. One click on the toolbar (or the keyboard shortcut) starts it; another click stops it. For the detailed analysis view — evaluation, principal variation, settings — open Chrome's side panel by right-clicking the toolbar icon and choosing "Open side panel."

Everything runs locally on your computer. No account, no sign-up, no data leaves your device. The Stockfish 18 Lite engine, the YOLOv11 board-recognition model, and the PaddleOCR orientation model are all bundled with the extension and load from the local extension bundle. No network calls during analysis.

Chessray does not run on chess.com or lichess.org. Both sites have active anti-cheat policies against engine-assisted play; the on-page overlay is excluded from those hosts at the manifest level and the service worker hard-refuses to start tab capture there from every entry point (toolbar, keyboard shortcut, context menu, side-panel CTA). Chessray is built for streams, videos, and study material, not live play on those platforms.

Privacy: Chessray does not transmit pixels, recognized positions, evaluations, or any other data off your device. Full privacy policy: https://github.com/chessraygg/chessray/blob/main/docs/chrome-webstore/privacy-policy.md

Bugs, feature requests, or anything else — reach out at chessraygg@gmail.com or open an issue at https://github.com/chessraygg/chessray/issues.

Open source under GPL-3.0: https://github.com/chessraygg/chessray
```

Dashboard hint: _"Focus on explaining what the item does and why users
should install it"_ — the lede covers what, the "How it's different"
paragraph covers why, and the chess.com/lichess paragraph short-circuits
the most likely reviewer objection.

### Category
```
Tools
```
Closest match in the dashboard's category list. Alternative: `Productivity`
(less specific but higher discovery on the Web Store homepage).

### Language
```
English (United States)
```

---

## Store listing → Graphic assets

### Store icon — 128×128 px, PNG, no alpha — required
✓ already in repo: `packages/extension/src/icons/icon-128.png` (auto-included in the zip; the dashboard reads it from there).

### Global promo video — YouTube URL — optional
Skip for v1. Add later if a 30–60 s demo video is recorded showing capture on a Twitch chess stream.

### Screenshots — 1280×800 or 640×400, JPEG/PNG no alpha, max 5, ≥1 required
Suggested set (capture Chrome window at exactly 1280×800):
1. **Hero shot** — on-page overlay (top-move arrows + eval bar) drawn on a board, ideally with the side panel (manually opened via right-click toolbar → Open side panel) also visible, on a YouTube chess video or a Twitch chess stream. This is the one that converts. (Don't use a lichess.org screenshot — it contradicts the blocklist.)
2. **Close-up overlay** — zoomed-in view of arrows + eval bar painted on a board mid-game.
3. **Side panel detail** — full analysis view (eval, PV, settings).
4. **Twitch chess stream** — Hikaru / chessbrah / BotezLive with Chessray's overlay live. Demonstrates the "live streams" use case.
5. **PDF or screenshot** — Chessray analyzing a chess book opened in Chrome's PDF viewer, or a screenshot of a chess position. Demonstrates the "anything on screen" use case.

**Do NOT screenshot chess.com or a live lichess.org game** — Chessray is hard-blocked on those hosts and the contradiction will trip the reviewer.

### Small promo tile — 440×280 — required
Used in search results and category pages. Should include: the Chessray name, a short tagline ("live chess engine overlay"), and a recognizable visual (a chess board with an arrow drawn on it).

### Marquee promo tile — 1400×560 — optional
Required only for "Featured" eligibility. Skip for v1.

---

## Store listing → Additional fields

### Official URL — verified site only — optional
```
None
```
Leave unset. Chessray does not have an associated verified site in Google Search Console. (If a `chessray.com` is set up later, register it as the owner in Search Console and select it here.)

### Homepage URL — 0/2,048 chars
```
https://github.com/chessraygg/chessray
```

### Support URL — 0/2,048 chars
```
https://github.com/chessraygg/chessray/issues
```
GitHub Issues is where users should report bugs. Reviewers occasionally check that this URL works.

### Contact email (publisher-level — Account → Account info, NOT per-item)
```
chessraygg@gmail.com
```
Set this in **Account → Account info → Email address** at the publisher level. The Web Store doesn't have a per-item contact-email field — the publisher email is what reviewers and users see for support communication. Also pasted into the detailed Description above so it's discoverable from the public store listing without leaving the page.

### Mature content
```
No
```
No sexual content, no strong language, no violence, no alcohol/tobacco/drugs.

---

## Privacy

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
The Chessray analysis UI (board view, eval, PV, settings) lives in Chrome's side panel. The sidePanel permission is required to declare the side-panel surface in manifest.json so Chrome exposes the "Open side panel" entry on the right-click menu of the extension's toolbar icon. The panel is opened by the user from that menu.
```

**`contextMenus`**
```
Provides a right-click "Chessray: Capture this tab" entry. Some Chrome versions suppress the toolbar action click when a side panel is configured; the context menu is a reliable fallback for invoking capture with a user gesture.
```

**Host permission: `<all_urls>`**
```
The on-page overlay is a content script that draws arrows, an eval bar, and a PV preview board on top of the captured board. The user may invoke Chessray on any site that happens to show a chess board (Twitch / YouTube streams, image viewers, PDF readers, screenshots, replay / study pages, archived games), so the script's match pattern cannot be narrowed to a fixed allowlist without breaking the long tail of sites where the feature is useful. No site is read or modified — the overlay is drawn into a top-level container; no page DOM is queried. chess.com and lichess.org are excluded explicitly: content_scripts.exclude_matches in the manifest prevents the overlay from ever injecting on those hosts, and a service-worker guard refuses to start tabCapture on those hosts from every invocation path (toolbar click, keyboard shortcut, context menu, side-panel CTA). The extension cannot be used to assist live games on either platform.
```

### Remote code
```
No, I am not using Remote code
```
All executable code ships inside the extension bundle. Stockfish (WASM), ONNX-runtime (WASM + JS), the YOLO model (.onnx), and PaddleOCR (model + JS) are loaded from `chrome.runtime.getURL('vendor/…')`. No `fetch` of remote JS/WASM/HTML at runtime, no `eval`, no `new Function`. The CSP allows only `'wasm-unsafe-eval'` (required for WASM instantiation), not `'unsafe-eval'`. `scripts/build-webstore.mjs` validates this on every build: any `localhost`, `127.0.0.1`, `@vite/env`, or `@crx/client` reference in the dist fails the build.

### Data usage — "What user data do you plan to collect from users now or in the future?"

Tick exactly one box (the last one). Per-row answers, in the order the dashboard lists them:

| Checkbox | Tick? | Rationale (paste in the "Why?" box if dashboard prompts) |
| --- | --- | --- |
| Personally identifiable information | **No** | No name, email, address, age, or ID collected. No sign-up, no account. |
| Health information | **No** | None. |
| Financial and payment information | **No** | Extension is free, no payment flow, no credit/financial data touched. |
| Authentication information | **No** | No passwords, credentials, security questions, or PINs read or stored. |
| Personal communications | **No** | No email, text, or chat content read. |
| Location | **No** | No geolocation API used. No IP address recorded or transmitted. |
| Web history | **No** | Does not read browsing history. Reads only the active tab's URL once per invocation to apply the chess.com / lichess.org blocklist — URL is not logged, stored, or transmitted. |
| User activity | **No** | No keystroke logging, no mouse-position tracking, no click monitoring, no scroll telemetry. |
| Website content | **Yes** | Tab pixels (via `chrome.tabCapture`) are read frame-by-frame to find a chess board, recognize pieces, and discard the frame in memory. Pixels never leave the device. The "Website content" example in the dashboard explicitly lists "images" — captured frames are images, so the honest answer is Yes. |

### Three certification disclosures (all required)
Tick all three:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

All three are true for Chessray: no third parties, single purpose is engine-overlay analysis of the captured board, no financial use.

### Privacy policy URL
```
https://github.com/chessraygg/chessray/blob/main/docs/chrome-webstore/privacy-policy.md
```

---

## Distribution

### Visibility
```
Public
```
Anyone can find and install from the Web Store.

### Regions
```
All regions
```
No geo-restriction; the analysis runs locally regardless of locale.

### Pricing
```
Free
```

---

## Access

### Trusted testers
N/A — Public visibility. Skip the trusted testers email list.

### Group publisher
Already publishing under the existing `digest.tube` publisher account (reuse for shared support email, payment profile, and reviewer trust signals).

---

## Test instructions (visible only to the reviewer)

Paste this into the **Test instructions** tab. Reviewers reject extensions
with `tabCapture` + `<all_urls>` without clear repro steps. The block below
is kept under 500 chars on purpose — long test-instructions copy gets
skimmed; this fits in the reviewer's eyeline at full zoom.

```
1. Open any chess YouTube video (e.g. agadmator).
2. Click the toolbar icon (or Alt+Shift+C). Red ● badge appears.
3. Within ~1s: arrows + eval bar painted on the board. Overlay updates as the video plays — no manual scan.
4. Click toolbar icon to stop. Blocklist: chess.com / lichess refuse capture; red OFF badge flashes 2s.
5. Open side panel manually: right-click toolbar icon → Open side panel.

All analysis runs on-device. No network requests during capture.
```

Demo video on request — email chessraygg@gmail.com.

---

## Submission checklist

Before clicking **Submit for review**:

- [ ] Production zip built via `npm run build:webstore` from latest `main`
- [ ] Zip uploaded to the Package tab and parsed without errors
- [ ] Manifest version in zip is monotonically greater than any previously uploaded version
- [ ] **Store listing → Product details:** Description pasted, Category set, Language set
- [ ] **Store listing → Graphic assets:** Store icon auto-detected (128×128); ≥1 screenshot at 1280×800; 440×280 promo tile uploaded
- [ ] **Store listing → Additional fields:** Homepage URL, Support URL set; Mature content = No
- [ ] **Account → Account info → Email address** set to `chessraygg@gmail.com` (publisher-level; what users and reviewers see for support)
- [ ] **Privacy → Single purpose:** description pasted
- [ ] **Privacy → Permission justifications:** all 7 blocks pasted (tabCapture, offscreen, scripting, storage, sidePanel, contextMenus, host_permissions)
- [ ] **Privacy → Remote code:** "No, I am not using Remote code"
- [ ] **Privacy → Data usage:** only "Website content" checked (other 8 left unchecked) + 3 certifications ticked
- [ ] **Privacy → Privacy policy URL:** pasted and returns 200 in an incognito tab
- [ ] **Distribution:** Public, All regions, Free
- [ ] **Access:** Trusted testers list left empty
- [ ] **Test instructions:** pasted (reviewers reject without it for tabCapture + `<all_urls>` items)
- [ ] `manifest.json` in zip has no `localhost` references and no wildcard `web_accessible_resources` (auto-checked by `build:webstore`)
