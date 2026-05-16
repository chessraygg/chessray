#!/usr/bin/env node
/**
 * Build the Chrome Web Store upload artifact for the Chessray extension.
 *
 *   node scripts/build-webstore.mjs
 *
 * Steps:
 *   1. Run `vite build` in packages/extension (production mode — CRXJS
 *      emits a clean MV3 bundle without HMR/localhost shims).
 *   2. Validate dist/manifest.json: no localhost references, no wildcard
 *      web_accessible_resources, expected permissions, no 'unsafe-eval'.
 *   3. Scan every file under dist/ for accidental localhost / 127.0.0.1
 *      references (would be a dev-build artifact).
 *   4. Zip dist/ contents into releases/chessray-v<version>.zip.
 *
 * Fails loudly on any validation failure — the goal is to make it
 * impossible to upload a dev build to the store by accident.
 */

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, statSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const extDir = join(repoRoot, 'packages', 'extension');
const distDir = join(extDir, 'dist');
const releasesDir = join(repoRoot, 'releases');

function fail(msg) {
  console.error(`\n[build-webstore] FAIL: ${msg}\n`);
  process.exit(1);
}

function info(msg) {
  console.log(`[build-webstore] ${msg}`);
}

function run(cmd, cwd) {
  info(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const pkg = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8'));
const version = pkg.version;
info(`extension version: ${version}`);

info('running production build');
run('npm run build', extDir);

info('validating dist/manifest.json');
const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));

if (manifest.version !== version) {
  fail(`manifest version (${manifest.version}) != package.json version (${version})`);
}

const swPath = manifest?.background?.service_worker;
if (!swPath) fail('manifest.background.service_worker is missing');
const swSource = readFileSync(join(distDir, swPath), 'utf8');
if (/localhost|127\.0\.0\.1/i.test(swSource)) {
  fail(`service worker references localhost/127.0.0.1 — this is a dev build. ` +
       `Stop the dev server (scripts/local/extension-dev.sh stop) and re-run.`);
}

const war = manifest.web_accessible_resources ?? [];
for (const entry of war) {
  const resources = entry.resources ?? [];
  for (const r of resources) {
    if (r === '*' || r === '**/*') {
      fail(`web_accessible_resources contains wildcard "${r}" — this is a CRXJS ` +
           `dev artifact that exposes every file in the extension to all websites.`);
    }
  }
}

const csp = manifest?.content_security_policy?.extension_pages ?? '';
if (csp.includes("'unsafe-eval'")) {
  fail(`content_security_policy contains 'unsafe-eval' — store will reject. ` +
       `Only 'wasm-unsafe-eval' is allowed.`);
}
if (!csp.includes("'wasm-unsafe-eval'")) {
  fail(`content_security_policy is missing 'wasm-unsafe-eval' — Stockfish WASM ` +
       `will fail to instantiate.`);
}

const requiredPerms = ['tabCapture', 'offscreen', 'scripting', 'storage', 'sidePanel'];
const perms = manifest.permissions ?? [];
for (const p of requiredPerms) {
  if (!perms.includes(p)) fail(`required permission "${p}" missing from manifest`);
}

info('validating no localhost references in any dist file');
let localhostHits = 0;
for (const f of walk(distDir)) {
  if (f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.wasm') ||
      f.endsWith('.onnx') || f.endsWith('.bin') || f.endsWith('.zip')) continue;
  const text = readFileSync(f, 'utf8');
  if (/localhost:5173|127\.0\.0\.1:5173|@vite\/env|@crx\/client/.test(text)) {
    console.error(`  ${relative(distDir, f)}`);
    localhostHits++;
  }
}
if (localhostHits > 0) {
  fail(`${localhostHits} dist file(s) reference dev-server URLs (see above). ` +
       `This is a dev build. Stop scripts/local/extension-dev.sh and re-run.`);
}

info('checking vendor/ assets present in dist');
for (const sub of ['stockfish', 'onnxruntime-web', 'yolo-chess', 'paddle-ocr']) {
  const vd = join(distDir, 'vendor', sub);
  if (!existsSync(vd)) {
    fail(`dist/vendor/${sub} missing — run "npm run setup" first to download vendor assets`);
  }
  if (readdirSync(vd).length === 0) fail(`dist/vendor/${sub} is empty`);
}

mkdirSync(releasesDir, { recursive: true });
const zipName = `chessray-v${version}.zip`;
const zipPath = join(releasesDir, zipName);

if (existsSync(zipPath)) rmSync(zipPath);

info(`zipping dist/ → releases/${zipName}`);
// -r recursive, -X strip extra macOS attrs (store linter dislikes them),
// -q quiet. Run from inside dist/ so paths in the zip are flat — store
// upload expects manifest.json at the zip root.
run(`zip -r -X -q "${zipPath}" .`, distDir);

const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
info(`done — releases/${zipName} (${sizeMB} MB)`);
info(`upload to https://chrome.google.com/webstore/devconsole`);
