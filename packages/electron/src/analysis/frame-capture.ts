import { initEngine, initRecognizer, getOnnxSession } from './engine-init.js';

export let TARGET_FPS = 2;

/** Measured upstream cost for a single captured frame, before the pipeline runs. */
export interface FrameMeta {
  /** drawImage + getImageData duration in ms. */
  capture_ms: number;
  /** Date.now() right after the frame was captured, for IPC + render timing downstream. */
  captured_at: number;
}

let captureOnFrame: ((imageData: ImageData, meta: FrameMeta) => Promise<void>) | null = null;
let captureCtx: CanvasRenderingContext2D | null = null;
let captureCanvas: HTMLCanvasElement | null = null;
let captureVideo: HTMLVideoElement | null = null;
let captureResetState: (() => void) | null = null;
/** Module-scope guard so setTargetFps and initAndStartCapture share the same
 *  flag — without this, recreating the interval on FPS change would start a
 *  second concurrent processFrame while the first is still mid-inference,
 *  racing on canvas/processor state and eventually wedging the renderer. */
let captureIsProcessing = false;

function startCaptureIntervalAtCurrentFps(): void {
  if (!captureOnFrame || !captureCtx || !captureCanvas || !captureVideo) return;
  if (captureInterval) clearInterval(captureInterval);
  const ctx = captureCtx;
  const canvas = captureCanvas;
  const video = captureVideo;
  const onFrame = captureOnFrame;
  const resetState = captureResetState;
  captureInterval = setInterval(async () => {
    if (captureIsProcessing) return;
    if (video.videoWidth > 0 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      resetState?.();
    }
    captureIsProcessing = true;
    const tCap = Date.now();
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const captured_at = Date.now();
    const meta: FrameMeta = { capture_ms: captured_at - tCap, captured_at };
    try {
      await onFrame(imageData, meta);
    } finally {
      captureIsProcessing = false;
    }
  }, 1000 / TARGET_FPS);
}

export function setTargetFps(fps: number): void {
  const next = Math.max(1, Math.min(10, fps));
  // No-op when the rate hasn't actually changed — avoids recreating the
  // interval (and the orphaned in-flight processFrame race) every time the
  // auto-tuner toggles between two values it already settled on.
  if (next === TARGET_FPS && captureInterval) return;
  TARGET_FPS = next;
  if (captureInterval && captureOnFrame && captureCtx && captureCanvas && captureVideo) {
    startCaptureIntervalAtCurrentFps();
  }
}

let mediaStream: MediaStream | null = null;
let captureInterval: ReturnType<typeof setInterval> | null = null;
let videoElement: HTMLVideoElement | null = null;
let captureGeneration = 0;

export function getCaptureGeneration(): number { return captureGeneration; }

function debugLog(msg: string): void {
  console.log(`[chessray] ${msg}`);
  window.chessRay.sendDebugLog(msg);
}

export async function initAndStartCapture(
  sourceId: string,
  onFrame: (imageData: ImageData, meta: FrameMeta) => Promise<void>,
  resetState: () => void,
): Promise<void> {
  stopCapture(resetState);
  const myGeneration = ++captureGeneration;

  try {
    debugLog('Initializing engine + recognizer...');
    await Promise.all([initEngine(), initRecognizer()]);
    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture — a newer call superseded this one');
      return;
    }
    debugLog('Engine + recognizer ready');

    const onnxSession = getOnnxSession();
    const gpuAvailable = !!(globalThis as any).navigator?.gpu;
    const ep = onnxSession?.handler?.backendHint ?? 'unknown';
    debugLog(`Backend: ONNX EP=${JSON.stringify(ep)}, WebGPU available=${gpuAvailable}, OpenCV=WASM`);

    // Get desktop capture stream using Electron's chromeMediaSource: 'desktop'
    debugLog(`Getting media stream for source: ${sourceId.slice(0, 30)}...`);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        // @ts-expect-error Electron-specific mandatory constraints for desktop capture
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
      audio: false,
    });
    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture — stopping acquired stream');
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    mediaStream = stream;
    debugLog(`MediaStream obtained: ${mediaStream.getVideoTracks().length} video tracks, active=${mediaStream.active}`);

    const videoTrack = mediaStream.getVideoTracks()[0];
    if (videoTrack) {
      const settings = videoTrack.getSettings();
      debugLog(`Video track: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
    }

    if (videoElement) {
      videoElement.pause();
      videoElement.srcObject = null;
      videoElement.remove();
    }

    const video = document.createElement('video');
    videoElement = video;
    video.srcObject = mediaStream;
    video.muted = true;
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    document.body.appendChild(video);

    const canvas = document.getElementById('capture-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    try {
      await video.play();
      debugLog(`video.play() succeeded, readyState=${video.readyState}, size=${video.videoWidth}x${video.videoHeight}`);
    } catch (err) {
      throw new Error(`video.play() failed: ${err}`);
    }

    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture after video.play()');
      video.pause();
      video.srcObject = null;
      video.remove();
      mediaStream?.getTracks().forEach(t => t.stop());
      return;
    }

    if (video.videoWidth === 0) {
      debugLog('Waiting for video dimensions...');
      await new Promise<void>((resolve) => {
        const onResize = () => {
          if (video.videoWidth > 0) {
            video.removeEventListener('resize', onResize);
            resolve();
          }
        };
        video.addEventListener('resize', onResize);
        video.addEventListener('loadedmetadata', () => {
          if (video.videoWidth > 0) resolve();
        });
        setTimeout(resolve, 5000);
      });
      debugLog(`After wait: size=${video.videoWidth}x${video.videoHeight}, readyState=${video.readyState}`);
    }

    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture after dimension wait');
      video.pause();
      video.srcObject = null;
      video.remove();
      mediaStream?.getTracks().forEach(t => t.stop());
      return;
    }

    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;

    // Wait for first non-black frame
    let gotRealFrame = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const sample = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      if (sample[0] + sample[1] + sample[2] > 0) {
        gotRealFrame = true;
        debugLog(`Non-black frame at attempt ${attempt}, pixel=[${sample[0]},${sample[1]},${sample[2]}]`);
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }

    if (!gotRealFrame) {
      debugLog('WARNING: All frames are black after 5s — starting capture anyway');
    }

    if (myGeneration !== captureGeneration) {
      debugLog('Stale initAndStartCapture after frame wait');
      video.pause();
      video.srcObject = null;
      video.remove();
      mediaStream?.getTracks().forEach(t => t.stop());
      return;
    }

    debugLog(`Starting frame capture at ${TARGET_FPS}fps, canvas=${canvas.width}x${canvas.height}`);

    // Store references for setTargetFps to restart the interval
    captureOnFrame = onFrame;
    captureCtx = ctx;
    captureCanvas = canvas;
    captureVideo = video;
    captureResetState = resetState;
    // Both this initial start and any later setTargetFps go through the same
    // helper using the module-scope captureIsProcessing flag, so an interval
    // recreated mid-frame can never start a second concurrent processFrame.
    startCaptureIntervalAtCurrentFps();

  } catch (err) {
    debugLog(`Init/capture FAILED: ${err}`);
    throw err;
  }
}

export function stopCapture(resetPipelineState?: () => void): void {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  captureIsProcessing = false;
  if (videoElement) {
    videoElement.pause();
    videoElement.srcObject = null;
    videoElement.remove();
    videoElement = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (resetPipelineState) resetPipelineState();
}
