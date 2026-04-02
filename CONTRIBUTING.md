# Contributing to ChessRay

## Setup

1. Install [Node.js](https://nodejs.org/) 20+ and [Git LFS](https://git-lfs.github.com/)
2. Fork the repo and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/chessray.git
   cd chessray
   ```
3. Install dependencies: `npm install`
4. Download vendor assets: `npm run setup`
5. Run tests to verify: `npm test`

## Contribution workflow

1. **Open an issue first.** Before starting work, open an issue describing the bug or feature. This avoids wasted effort on changes that may not be accepted.
2. **Create a branch** from `main`:
   - `feature/short-description` for new features
   - `fix/short-description` for bug fixes
   - `docs/short-description` for documentation changes
3. **Make your changes.** Keep commits focused. Run `npm test` before pushing.
4. **Open a pull request** against `main`. Reference the issue number in the PR description.
5. **CI must pass** and at least one maintainer approval is required before merge.

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **PATCH** (0.1.x) — bug fixes
- **MINOR** (0.x.0) — new features, non-breaking changes
- **MAJOR** (x.0.0) — breaking changes

While at 0.x, breaking changes may occur in minor versions. Releases are created by pushing a `v*` tag (e.g. `v0.2.0`), which triggers CI to build and publish executables.

## Development

Start the app in dev mode:

```bash
./app.sh start    # start
./app.sh log      # view logs
./app.sh stop     # stop
```

## Project Structure

- `packages/core/` — Shared detection, recognition, and evaluation logic
- `packages/electron/` — Electron app with two renderer windows (analysis + overlay)
- `vendor/` — Downloaded at setup: Stockfish WASM, ONNX Runtime
- `test/` — Vitest tests with screenshot fixtures

## Testing

```bash
npm test                          # run all tests
npm run test:e2e                  # Playwright E2E tests
npm run gen-expected              # regenerate expected test images
npm run gen-expected -- <filter>  # regenerate specific test case
```

### How test cases work

Each test case is defined in `test/fixtures/highlight-cases.ts` with a screenshot and the expected ground truth (FEN, highlighted squares, board orientation, bounding box). Tests run the detection pipeline on the screenshot and assert the output matches the ground truth.

`npm run gen-expected` generates side-by-side visualization images in `test/fixtures/expected-images/` — the original screenshot on the left with the detected bounding box overlaid, and a virtual board on the right rendered from the expected FEN. These images are for **human review only** — they let you visually verify that a test case's ground truth is correct before committing it. They are not used by the test runner.

## Building

```bash
npm run build                     # build distributables for your platform
```

Output goes to `packages/electron/out/make/`.

## Guidelines

- Keep changes focused — one feature or fix per PR
- Add tests for new detection/recognition logic
- Don't modify test expectations without discussion
- Run `npm test` before submitting
