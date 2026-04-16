/**
 * One-off helper: run the detection pipeline against every fixture in
 * test/fixtures/pipeline-cases.yaml and patch each case in-place with the
 * detected `expected_square_colors` (median light/dark square RGB).
 *
 * Idempotent: re-running just refreshes the values. Preserves YAML formatting
 * by string-editing the file rather than round-tripping through js-yaml.
 *
 * Usage:
 *   npx tsx scripts/sync-square-colors.ts
 *   npx tsx scripts/sync-square-colors.ts <filter>   # only files matching <filter>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as ort from 'onnxruntime-node';
import { PNG } from 'pngjs';
import { runDetectionPipeline, YoloPieceRecognizer } from '@chessray/core';
import { PIPELINE_CASES } from '../packages/core/test/fixtures/pipeline-cases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'packages', 'core', 'test', 'screenshots');
const YAML_PATH = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'pipeline-cases.yaml');
const MODEL_PATH = path.join(ROOT, 'vendor', 'yolo-chess', 'chess-pieces.onnx');

(globalThis as any).ort = ort;

function loadPng(name: string) {
  const png = PNG.sync.read(fs.readFileSync(path.join(SCREENSHOTS_DIR, name)));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

/** Insert or replace `expected_square_colors:` block for a given case in the YAML text. */
function patchCase(
  yamlText: string,
  fileName: string,
  light: [number, number, number],
  dark: [number, number, number],
): string {
  const lines = yamlText.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === `- file: ${fileName}` || l.trim() === `- file: ${fileName}`);
  if (startIdx < 0) throw new Error(`Could not find "- file: ${fileName}" in YAML`);

  // Find end of this case (next "- file:" line or EOF)
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('- file:')) { endIdx = i; break; }
  }

  // Look for existing expected_square_colors block within this case
  let scIdx = -1;
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (lines[i].trim().startsWith('expected_square_colors:')) { scIdx = i; break; }
  }

  const newBlock = [
    `  expected_square_colors:`,
    `    light: [${light[0]}, ${light[1]}, ${light[2]}]`,
    `    dark: [${dark[0]}, ${dark[1]}, ${dark[2]}]`,
  ];

  if (scIdx >= 0) {
    // Replace existing 3-line block (header + light + dark)
    lines.splice(scIdx, 3, ...newBlock);
  } else {
    // Insert before end of case (preserves trailing blank lines if any)
    let insertAt = endIdx;
    // Step back over blank lines so the new block is glued to the case
    while (insertAt > startIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, ...newBlock);
  }

  return lines.join('\n');
}

async function main() {
  const filter = process.argv[2];
  const cases = filter ? PIPELINE_CASES.filter(tc => tc.file.includes(filter)) : PIPELINE_CASES;

  console.log(`Running detection on ${cases.length} fixture(s)...`);
  const session = await ort.InferenceSession.create(MODEL_PATH);
  const recognizer = new YoloPieceRecognizer('');
  recognizer.session = session;
  recognizer.ort = ort;

  let yamlText = fs.readFileSync(YAML_PATH, 'utf8');
  let updated = 0;

  for (const tc of cases) {
    const { data, width, height } = loadPng(tc.file);
    const result = await runDetectionPipeline(session, ort, recognizer, data, width, height);
    if (!result.found) {
      console.warn(`  SKIP ${tc.file} — board not detected`);
      continue;
    }
    const light = result.highlightMedians.light.map(Math.round) as [number, number, number];
    const dark = result.highlightMedians.dark.map(Math.round) as [number, number, number];
    yamlText = patchCase(yamlText, tc.file, light, dark);
    console.log(`  ${tc.file}: light=[${light.join(',')}] dark=[${dark.join(',')}]`);
    updated++;
  }

  fs.writeFileSync(YAML_PATH, yamlText);
  console.log(`\nUpdated ${updated} case(s) in ${path.relative(ROOT, YAML_PATH)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
