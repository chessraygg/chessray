# ChessRay

Real-time chess position recognition and evaluation overlay. ChessRay captures your screen, detects chess boards from anything visible — chess sites, streams, videos, images — recognizes pieces using a YOLOv11 model, and displays evaluation results as a transparent overlay.

## Features

- Detects chess boards and pieces from screen capture using YOLOv11n
- Detects highlighted squares and determines the last move played
- Determines board orientation via piece positions or OCR (optical character recognition, via Tesseract)
- Evaluates positions with Stockfish 18 (WASM) with iterative deepening
- Renders a transparent overlay with best-move arrows, eval bar, scores, and principal variation
- Works with anything on screen — chess sites, streams, videos, images — purely vision-based, no DOM scraping

## Supported Platforms

- macOS (ARM64, x64)
- Windows (x64)
- Linux (x64)

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Git LFS](https://git-lfs.github.com/) (for the YOLO model weights)
- npm 10+

## Setup

```bash
# Clone the repo (includes LFS files)
git clone https://github.com/chessraygg/chessray.git
cd chessray

# Install dependencies
npm install

# Download vendor assets (Stockfish, ONNX Runtime)
npm run setup

# Run tests to verify everything works
npm test
```

## Development

```bash
# Start the app in dev mode (macOS/Linux)
./app.sh start

# View logs
./app.sh log

# Stop the app
./app.sh stop

# Build and install locally
npm run install-app -w packages/electron
```

## Building Distributables

```bash
# Build for your current platform
npm run build

# Output goes to packages/electron/out/make/
```

## Project Structure

```
chessray/
  packages/
    core/         Shared detection, recognition & evaluation logic
    electron/     Electron app (main + overlay + analysis windows)
  vendor/         Pre-built engines & ML models (downloaded via npm run setup)
  test/           Board detection tests & fixtures
  scripts/        Build & utility scripts
```

## How It Works

1. **Screen capture** — Electron captures the primary screen
2. **Board detection** — YOLOv11n detects the chess board bounding box
3. **Piece recognition** — YOLOv11n identifies all pieces and their positions
4. **Highlight detection** — Detected highlighted squares determine the last move and whose turn it is
5. **Board orientation** — Determined from piece positions or OCR of coordinate labels (Tesseract)
6. **FEN generation** — Detected pieces are mapped to a FEN (Forsyth-Edwards Notation) string
7. **Evaluation** — Stockfish 18 Lite (WASM, Web Worker) evaluates with iterative deepening and LRU (least recently used) caching
8. **Overlay** — Best-move arrows, eval bar, scores, and PV (principal variation) line are rendered on a transparent, always-on-top window

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

Stockfish is licensed under GPLv3. The YOLO chess piece model is based on [NAKSTStudio/Chess](https://universe.roboflow.com/nakststudio/chess-pieces-new) YOLOv11n weights.
