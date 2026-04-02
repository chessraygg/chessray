import { detectBoard } from '@chessray/core';
import fs from 'fs';
import { PNG } from 'pngjs';

const png = PNG.sync.read(fs.readFileSync('test/screenshots/test-caruana-padded.png'));
const data = new Uint8ClampedArray(png.data);
const result = detectBoard(data, png.width, png.height);

console.log(`Padded (${png.width}x${png.height}): found=${result.found} conf=${result.confidence.toFixed(2)}`);
console.log(`Detected: ${JSON.stringify(result.bbox)}`);
console.log(`Expected: x=91, y=331, size=1122`);

if (result.bbox) {
  const b = result.bbox;
  console.log(`Error: dx=${b.x - 91}, dy=${b.y - 331}, dsize=${b.width - 1122}`);
}
