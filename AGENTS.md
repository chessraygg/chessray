# AGENTS.md

This file provides repository-wide guidance for AI coding assistants (Claude Code, Cursor, Aider, Codex, etc.). It documents the project's stack, architecture, and engineering conventions so generated changes fit the codebase.

## Project

Electron app for real-time chess position recognition and evaluation, rendered as a transparent overlay on screen. Detection is purely vision-based (screen capture + ML models) — never DOM-based.

## Stack

- TypeScript, Vitest
- YOLOv11n (ONNX) for board and piece detection
- Tesseract.js for OCR-based board orientation
- Stockfish 18 Lite (WASM) for position evaluation
- chess.js for move generation and board manipulation
- pngjs for image I/O in tests

## Architecture

Monorepo with two packages:

- `packages/core/` — Detection, recognition, and evaluation logic (platform-independent). Organized by concern:
  - `board/` — board bbox detection
  - `recognition/` — piece recognition (YOLO ONNX)
  - `highlight/` — highlighted-square detection (last move)
  - `orientation/` — board orientation (piece-position heuristic + Tesseract OCR fallback)
  - `fen/` — FEN generation from detected pieces
  - `engine/` — Stockfish (WASM) wrapper, eval cache, multi-PV
  - `pipeline/` — end-to-end detection pipeline orchestrating the above
- `packages/electron/` — Electron app with two renderer windows:
  - **Analysis window** (hidden) — runs the detection pipeline
  - **Overlay window** (visible, transparent, click-through) — renders arrows, eval bar, scores, PV board

Platform-specific code is isolated in `packages/electron/src/main/platform.ts` via an adapter pattern.

## Engineering conventions

- **Vision-based only.** The detection pipeline must rely on screen capture and ML models. Do not introduce DOM scraping, accessibility-tree reading, or site-specific integrations into detection code.
- **Prefer fail-fast error handling.** Surface unexpected errors instead of swallowing them. Reserve `try`/`catch` for cases with a meaningful recovery path; do not log-and-continue on conditions that indicate a bug.
- **Keep changes focused.** Avoid speculative abstractions, premature optimization, or scope creep. Implement what the task requires and stop.
- **Reuse established libraries.** Before writing non-trivial detection, computer-vision, or chess logic, check whether a proven library already solves it.
- **Treat tests as the specification.** Tests describe intended behavior. When a test fails, investigate the implementation first; only update an expectation when the spec itself has changed and that change is intentional.
- **Match existing structure.** New code should follow the subdirectory organization in `packages/core/src/` (one concern per subdir) and the platform-adapter pattern in `packages/electron/src/main/platform.ts`.

## Commands

- `npm test` — run all tests (Vitest)
- `npm test -- -t "<filter>"` — run a single test case by name (e.g. `npm test -- -t "carlsen-niemann"`)
- `npm run typecheck` — strict TypeScript typecheck across all workspaces (also enforced in CI)
- `npm run build` — build the Electron app
- `npm run setup` — download vendor assets (Stockfish, ONNX Runtime)
- `npm run install-app -w packages/electron` — build and install locally
- `npm run gen-expected` — regenerate expected-output images for highlight test cases
- `npm run gen-expected -- <filter>` — regenerate only cases matching filter (e.g. `caruana-american3`)
- `npm run release` — cut a release locally (normally CI does this on merge to main, see Release workflow)
- `npx tsx scripts/detect-screenshot.ts <filename>` — detect board from a screenshot in `test/screenshots/` and output a draft `PipelineTestCase` entry
- `./app.sh {start|stop|restart|log|forge-log|status}` — manage the Electron app in dev mode
