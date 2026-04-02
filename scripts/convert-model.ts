#!/usr/bin/env ts-node
/**
 * Convert the frozen model weights into a modern TF.js LayersModel.
 * Uses the Functional API to ensure proper input/output layer references.
 */

import fs from 'fs';
import path from 'path';

// Polyfill for Node 23+ (tfjs-node uses deprecated util.isNullOrUndefined)
const util = require('util');
if (!util.isNullOrUndefined) {
  util.isNullOrUndefined = (v: any) => v === null || v === undefined;
}

async function main(): Promise<void> {
  const tf = await import('@tensorflow/tfjs-node');

  const MODEL_DIR = path.resolve('models/piece-classifier');
  const OUTPUT_DIR = path.resolve('models/piece-classifier/converted');

  // Read weights
  const manifest = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'weights_manifest.json'), 'utf-8'));
  const shardPaths: string[] = manifest[0].paths;
  const weightSpecs: { name: string; dtype: string; shape: number[] }[] = manifest[0].weights;

  const shardBuffers = shardPaths.map((p: string) => fs.readFileSync(path.join(MODEL_DIR, p)));
  const allWeights = Buffer.concat(shardBuffers);

  let offset = 0;
  const weightMap = new Map<string, Buffer>();
  for (const spec of weightSpecs) {
    const numElements = spec.shape.reduce((a: number, b: number) => a * b, 1) || 1;
    const byteLength = numElements * 4;
    weightMap.set(spec.name, allWeights.subarray(offset, offset + byteLength) as Buffer);
    offset += byteLength;
  }

  // Build model with Functional API
  const input = tf.input({ shape: [32, 32, 1], name: 'input_tile' });

  let x: any = tf.layers.conv2d({
    kernelSize: 5, filters: 32, activation: 'relu', padding: 'same', name: 'conv1',
  }).apply(input);
  x = tf.layers.maxPooling2d({ poolSize: [2, 2], strides: [2, 2], name: 'pool1' }).apply(x);
  x = tf.layers.conv2d({
    kernelSize: 5, filters: 64, activation: 'relu', padding: 'same', name: 'conv2',
  }).apply(x);
  x = tf.layers.maxPooling2d({ poolSize: [2, 2], strides: [2, 2], name: 'pool2' }).apply(x);
  x = tf.layers.flatten({ name: 'flatten' }).apply(x);
  x = tf.layers.dense({ units: 1024, activation: 'relu', name: 'dense1' }).apply(x);
  const output = tf.layers.dense({ units: 13, activation: 'softmax', name: 'piece_output' }).apply(x);

  const model = tf.model({ inputs: input, outputs: output as any });
  model.summary();

  // Set weights
  model.getLayer('conv1').setWeights([
    tf.tensor(new Float32Array(weightMap.get('Variable')!.buffer, weightMap.get('Variable')!.byteOffset, 5*5*1*32), [5,5,1,32]),
    tf.tensor(new Float32Array(weightMap.get('Variable_1')!.buffer, weightMap.get('Variable_1')!.byteOffset, 32), [32]),
  ]);
  model.getLayer('conv2').setWeights([
    tf.tensor(new Float32Array(weightMap.get('Variable_2')!.buffer, weightMap.get('Variable_2')!.byteOffset, 5*5*32*64), [5,5,32,64]),
    tf.tensor(new Float32Array(weightMap.get('Variable_3')!.buffer, weightMap.get('Variable_3')!.byteOffset, 64), [64]),
  ]);
  model.getLayer('dense1').setWeights([
    tf.tensor(new Float32Array(weightMap.get('Variable_4')!.buffer, weightMap.get('Variable_4')!.byteOffset, 4096*1024), [4096,1024]),
    tf.tensor(new Float32Array(weightMap.get('Variable_5')!.buffer, weightMap.get('Variable_5')!.byteOffset, 1024), [1024]),
  ]);
  model.getLayer('piece_output').setWeights([
    tf.tensor(new Float32Array(weightMap.get('Variable_6')!.buffer, weightMap.get('Variable_6')!.byteOffset, 1024*13), [1024,13]),
    tf.tensor(new Float32Array(weightMap.get('Variable_7')!.buffer, weightMap.get('Variable_7')!.byteOffset, 13), [13]),
  ]);

  // Test prediction
  const testInput = tf.zeros([1, 32, 32, 1]);
  const testOutput = model.predict(testInput) as tf.Tensor;
  const testData = await testOutput.data();
  console.log('Test prediction (blank tile):', Array.from(testData).map(v => v.toFixed(3)));
  testInput.dispose();
  testOutput.dispose();

  // Save
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await model.save(`file://${OUTPUT_DIR}`);

  // Verify
  const savedJson = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'model.json'), 'utf-8'));
  const topo = savedJson.modelTopology?.config || {};
  console.log('output_layers:', JSON.stringify(topo.output_layers));
  console.log('input_layers:', JSON.stringify(topo.input_layers));

  console.log(JSON.stringify({ success: true }));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
