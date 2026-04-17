/**
 * Frame recorder — when recording is active, encodes each captured frame as
 * a PNG and ships the bytes over IPC to the main process for disk write.
 *
 * Encoding is done off the hot path (`void recordFrame(...)` is fire-and-forget);
 * the PNG work runs on the renderer event loop while the detection pipeline
 * proceeds. Timing-sensitive — do not await from `onFrame`.
 *
 * The sibling `.json` sidecar (one per frame) is produced in analysis.ts after
 * the processor completes, not here, because only the processor knows the result.
 */

import type { ImageDataLike } from './frame-processor.js';

let recording = false;
let frameN = 0;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

export function setRecording(active: boolean): void {
  recording = active;
  if (active) frameN = 0;
}

export function isRecording(): boolean { return recording; }

/** Current 0-based frame index (incremented per recorded PNG). */
export function currentFrameIndex(): number { return frameN; }

/** Filename for the frame that is about to be saved (padded 6 digits). */
export function currentFrameFilename(): string {
  return `frame-${String(frameN).padStart(6, '0')}.png`;
}

/** Encode and ship the PNG. Call once per captured frame while recording.
 *  Fire and forget — awaiting would stall the capture loop. */
export async function recordFrame(imageData: ImageDataLike): Promise<void> {
  if (!recording) return;
  if (!canvas) {
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d')!;
  }
  if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
  }
  const dom = new ImageData(
    imageData.data as unknown as Uint8ClampedArray<ArrayBuffer>,
    imageData.width,
    imageData.height,
  );
  ctx!.putImageData(dom, 0, 0);
  const filename = currentFrameFilename();
  frameN++;
  const blob = await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const buf = new Uint8Array(await blob.arrayBuffer());
  window.chessRay.saveFrameArtifact(filename, buf);
}

/** Save the per-frame PipelineResult JSON sidecar alongside the PNG. */
export function recordResultSidecar(pngFilename: string, result: unknown): void {
  if (!recording) return;
  const jsonName = pngFilename.replace(/\.png$/, '.json');
  const text = JSON.stringify(result, null, 2);
  const buf = new TextEncoder().encode(text);
  window.chessRay.saveFrameArtifact(jsonName, buf);
}
