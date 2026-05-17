# Chessray Privacy Policy

_Last updated: 2026-05-16_

Chessray is a Chrome extension that recognizes chess positions from the active
browser tab using on-device computer-vision and chess-engine models, and
displays the analysis as an overlay on the page.

## Summary

**Chessray does not collect, transmit, sell, or share any personal data.**
All processing — screen-frame capture, board detection, piece recognition,
and Stockfish evaluation — happens locally inside the browser. No data ever
leaves the user's machine.

## What the extension accesses

- **Tab pixels (via `tabCapture`).** When the user starts Chessray on a tab,
  Chrome's tab-capture API delivers a video stream of that tab's rendered
  content to an in-extension offscreen document. Frames are processed in
  memory and discarded immediately; no video, no screenshots, and no derived
  positions are stored on disk or transmitted off-device.
- **Active tab URL (via `activeTab` / `<all_urls>`).** Chessray reads the URL
  of the active tab only to confirm it can inject the on-page overlay
  (it skips non-http(s) pages such as `chrome://` and the extension store).
  URLs are not logged, stored, or transmitted.
- **Local extension storage (via `storage`).** User preferences (overlay
  size/opacity, sidebar layout, etc.) and a short in-memory trace ring used
  for diagnostics are kept in `chrome.storage.local` / `chrome.storage.session`
  on the user's device. No account, identity, or telemetry data is stored.

## What the extension does NOT do

- Does **not** make network requests to any Chessray-operated server.
- Does **not** transmit captured pixels, recognized FENs, evaluations, or
  any other derived data off the device.
- Does **not** use third-party analytics, crash reporting, or advertising
  SDKs.
- Does **not** read DOM content, cookies, passwords, form input, browsing
  history, or any data outside the captured video stream.
- Does **not** read or modify any other tab.
- Does **not** run on chess.com or lichess.org. The on-page overlay is
  excluded from those hosts at the manifest level
  (`content_scripts.exclude_matches`) and the service worker hard-refuses
  to start tab capture there from every invocation path — toolbar click,
  keyboard shortcut, context menu, and side-panel CTA.

## Third-party services

Chessray includes an optional "Open in Lichess" button. When the user
explicitly clicks it, Chrome opens `https://lichess.org/analysis/<FEN>` in a
new tab. The current position (FEN string only) appears in that URL.
Lichess is operated by a third party and its own privacy policy applies to
that page. Chessray does not send anything to Lichess in the background;
this only happens on explicit user action.

## Bundled models

The extension ships with the following models, all loaded locally from the
extension bundle (`chrome.runtime.getURL`) — none are downloaded at runtime:

- YOLOv11n (ONNX) for board and piece detection
- PaddleOCR for board orientation
- Stockfish 18 Lite (WASM) for position evaluation

## Permissions, in plain language

| Permission        | Why it's needed |
| ----------------- | --------------- |
| `tabCapture`      | Capture the active tab's pixels so the vision pipeline can find a chess board. |
| `offscreen`       | Run the Stockfish WASM engine and ONNX inference off the service-worker thread. |
| `scripting`       | Inject the on-page overlay and read viewport size for accurate overlay placement. |
| `storage`         | Persist user preferences (overlay opacity, panel layout) across browser restarts. |
| `sidePanel`       | Declare the Chessray side-panel surface so Chrome exposes "Open side panel" on the right-click menu of the toolbar icon. The panel hosts the analysis UI. |
| `contextMenus`    | Provide a right-click "Capture this tab" entry as a fallback to the toolbar button. |
| `activeTab`       | Grant per-invocation access when the user clicks the toolbar button or uses the keyboard shortcut. |
| `<all_urls>`      | Allow the on-page overlay to draw on top of any site that contains a chess board (chess.com, lichess.org, YouTube, Twitch, image/PDF viewers, etc.). |

## Children's privacy

Chessray is suitable for general audiences and does not knowingly collect
information from anyone, including children under 13.

## Changes to this policy

Material changes will be reflected here and in the extension's Web Store
listing. The "Last updated" date above is authoritative.

## Contact

Bugs, privacy questions, feature requests, or anything else — reach out:

- Email: **chessraygg@gmail.com**
- Issue tracker: <https://github.com/chessraygg/chessray/issues>
- Source code: <https://github.com/chessraygg/chessray>
