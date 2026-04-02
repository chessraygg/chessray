# AGENTS.md

## Project

Electron app for real-time chess position recognition and evaluation, rendered as a transparent overlay on screen. Detection is purely vision-based (screen capture + ML models) — never DOM-based.

## Stack

- TypeScript, Vitest
- YOLOv11n (ONNX) for board and piece detection
- Tesseract.js for OCR-based board orientation
- Stockfish 18 Lite (WASM) for position evaluation
- pngjs for image I/O in tests

## Architecture

Monorepo with two packages:

- `packages/core/` — Detection, recognition, and evaluation logic (platform-independent)
- `packages/electron/` — Electron app with two renderer windows:
  - **Analysis window** (hidden) — runs the detection pipeline
  - **Overlay window** (visible, transparent, click-through) — renders arrows, eval bar, scores

Platform-specific code is isolated in `packages/electron/src/main/platform.ts` via an adapter pattern.

## Principles

- **Fail fast.** No fallbacks, no graceful degradation. If something fails, let it fail loudly. Never catch errors silently. Always `throw`, never log an error and continue.
- **No hacky solutions.** Don't layer fixes on top of a broken approach — step back and find the right one.
- **Never patch a wrong approach.** If the current implementation uses a wrong algorithm, REPLACE it. Do not add guardrails to a fundamentally wrong approach.
- **Keep it simple.** Don't over-engineer or add speculative features. No premature optimization.
- **Research first.** Before implementing detection/CV algorithms, search for established approaches. Don't invent custom solutions when proven ones exist.
- **Use libraries, don't reimplement.** If a battle-tested library exists, use it. One function call beats 200 lines of buggy reimplementation.
- **Never change test expectations without discussion.** Tests define the spec. If the implementation can't pass, fix the implementation — never weaken the test.

## Commands

- `npm test` — run board detection tests (Vitest)
- `npm run build` — build the Electron app
- `npm run setup` — download vendor assets (Stockfish, ONNX Runtime)
- `npm run install-app -w packages/electron` — build and install locally
- `npm run gen-expected` — regenerate expected-output images for highlight test cases
- `npm run gen-expected -- <filter>` — regenerate only cases matching filter (e.g. `caruana-american3`)
- `./app.sh {start|stop|restart|log|forge-log|status}` — manage the Electron app in dev mode
