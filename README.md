# Chessray

Real-time chess position recognition and evaluation, delivered as a Chrome extension that overlays Stockfish analysis on top of any chess board visible in your browser tab — chess sites, streams, videos, screenshots, PDFs. Everything runs locally; no pixels leave your machine.

A standalone Electron desktop app shares the same recognition + evaluation core for screen-wide capture outside the browser.

## Features

- **One-click capture in any tab** — toolbar button or `Alt+Shift+C` (rebindable at `chrome://extensions/shortcuts`) starts capturing the active tab. Analysis paints as an on-page overlay on the board; the detailed side-panel view is reachable via right-click on the toolbar icon → **Open side panel**.
- **Vision-based** — captures pixels and runs YOLOv11n to detect the board and recognize every piece. No DOM scraping, no site integrations, no chess-site allowlist.
- **Highlight + last-move detection** — finds the highlighted squares so it knows whose turn it is and what was just played, then renders the move as an arrow.
- **Orientation auto-detection** — figures out which side is at the bottom from piece positions, falling back to PaddleOCR on the coordinate labels.
- **Stockfish 18 Lite (WASM)** in an offscreen document — iterative deepening, configurable multi-PV, LRU eval cache.
- **On-page overlay** — top-move arrows and an eval bar drawn directly on the captured board.
- **Fully local** — no network calls during analysis; all models are bundled.

## Install

The published Chrome Web Store listing is the easiest path (link will be added once review completes).

To run from source while waiting for the store listing, see [Development](#development) below for loading the unpacked extension.

## How it works

1. **Tab capture** — Chrome's `tabCapture` API delivers a video stream of the active tab to an extension-bundled offscreen document.
2. **Board detection** — YOLOv11n locates the chess board bounding box; the bbox is cached per-frame using a cheap RGB fingerprint to skip the ~250 ms detection call when the surrounding UI hasn't moved.
3. **Piece recognition** — YOLOv11n classifies all 64 squares.
4. **Highlight detection** — Detected highlighted squares determine the last move and whose turn it is.
5. **Orientation** — Piece positions first; PaddleOCR fallback on the coordinate labels.
6. **FEN generation** — Detected pieces → Forsyth-Edwards Notation string.
7. **Evaluation** — Stockfish 18 Lite (WASM, Web Worker in the offscreen doc) with iterative deepening, multi-PV, and an LRU cache.
8. **Overlay** — Top-move arrows and an eval bar paint directly on top of the captured board; the side panel (opened manually via right-click on the toolbar icon → Open side panel) shows the same data plus full PV / settings / variation playback.

## Supported environments

- **Chrome extension** (primary): Chrome 116+ on macOS / Windows / Linux. Works on any site — chess sites (chess.com, lichess), video streams (Twitch, YouTube), image / PDF viewers, screenshots.
- **Electron desktop app** (secondary): macOS (ARM64, x64), Windows (x64), Linux (x64). Useful when the board is outside the browser (a native window, a non-Chrome screencast).

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Git LFS](https://git-lfs.github.com/) (for the YOLO model weights)
- npm 10+

## Setup

```bash
# Clone the repo (includes LFS files)
git clone https://github.com/chessraygg/chessray.git
cd chessray

# Install dependencies
npm install

# Download vendor assets (Stockfish, ONNX Runtime, YOLO model, PaddleOCR)
npm run setup

# Run tests to verify everything works
npm test
```

## Development

### Chrome extension

```bash
# Vite + CRXJS dev server — any Chrome that has packages/extension/dist/
# loaded as an unpacked extension auto-reloads on save.
npm run dev -w packages/extension
```

Load the extension once:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `packages/extension/dist/`

The side panel and service worker reload automatically; content scripts already injected into an open tab need that tab refreshed (Chrome MV3 limit).

### Electron desktop app

```bash
# Start in dev mode (cross-platform via electron-forge)
npm start -w packages/electron

# Build and install locally
npm run install-app -w packages/electron
```

## Building for release

### Chrome Web Store

```bash
npm run build:webstore
```

Runs a production Vite build, validates the manifest for store compliance (no localhost / HMR artifacts, no wildcard `web_accessible_resources`, CSP without `unsafe-eval`, all required permissions + vendor assets present), and produces `releases/chessray-v<version>.zip` ready to upload at <https://chrome.google.com/webstore/devconsole>.

Listing copy, single-purpose statement, and per-permission justifications live in [`docs/chrome-webstore/store-listing.md`](docs/chrome-webstore/store-listing.md). Privacy policy: [`docs/chrome-webstore/privacy-policy.md`](docs/chrome-webstore/privacy-policy.md).

### Electron distributable

```bash
npm run build
# Output → packages/electron/out/make/
```

## Project structure

```
chessray/
  packages/
    core/         Vision pipeline: board detection, piece recognition, FEN, highlights, orientation
    runtime/      Host-agnostic frame processor + eval cache, shared by extension and Electron
    overlay-ui/   Shared overlay/side-panel UI (renderer, PV cycling, settings, debug)
    extension/    Chrome MV3 extension (service worker, content script, side panel, offscreen doc)
    electron/     Electron desktop app (main + transparent overlay + hidden analysis window)
  vendor/         Pre-built engines & ML models (downloaded via npm run setup)
  docs/           Store-listing & privacy-policy docs
  test/           Board detection tests & fixtures
  scripts/        Build & utility scripts
```

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

Stockfish is licensed under GPLv3. The YOLO chess piece model is based on [NAKSTStudio/Chess](https://universe.roboflow.com/nakststudio/chess-pieces-new) YOLOv11n weights.
