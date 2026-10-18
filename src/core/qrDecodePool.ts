import QrDecodeWorker from "../workers/qrDecode.worker?worker";

interface DecodeResponse {
  id: number;
  frames: ArrayBuffer[];
  error?: string;
}

export type QrCarrierMode = "qr" | "color";

// Each worker instantiates its own ZXing WASM module (~1.5 MB), so the pool
// scales with logical cores but stays capped to keep low-end phones safe.
export function preferredDecodeWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(6, cores - 1));
}

export class QrDecodePool {
  private readonly workers: Worker[] = [];
  private readonly busy: boolean[] = [];
  private nextFrameId = 0;
  private completedFrames = 0;
  private replacedFrames = 0;
  private queuedImage: ImageData | null = null;

  constructor(
    count: number,
    private readonly mode: QrCarrierMode,
    private readonly onDecoded: (bytes: Uint8Array) => void,
    private readonly onError: (message: string) => void,
  ) {
    for (let index = 0; index < Math.max(1, count); index++) {
      const worker = new QrDecodeWorker();
      worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
        this.busy[index] = false;
        if (event.data.id === -1) {
          if (event.data.error) this.onError(event.data.error);
          return;
        }
        this.completedFrames += 1;
        if (event.data.error) this.onError(event.data.error);
        for (const frame of event.data.frames) this.onDecoded(new Uint8Array(frame));
        this.dispatchQueued(index);
      };
      worker.onerror = (event) => {
        this.busy[index] = false;
        this.onError(event.message || "二维码解码 Worker 运行失败");
      };
      this.workers.push(worker);
      this.busy.push(true);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  get busyCount(): number {
    return this.busy.filter(Boolean).length;
  }

  get completedCount(): number {
    return this.completedFrames;
  }

  get replacedCount(): number {
    return this.replacedFrames;
  }

  submit(image: ImageData): boolean {
    const index = this.busy.indexOf(false);
    if (index >= 0) {
      this.dispatch(index, image);
      return true;
    }
    // All workers busy: keep only the freshest frame so a worker freeing up
    // always decodes the latest camera image instead of a stale one.
    if (this.queuedImage) this.replacedFrames += 1;
    this.queuedImage = image;
    return false;
  }

  terminate(): void {
    this.queuedImage = null;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.busy.length = 0;
  }

  private dispatchQueued(index: number): void {
    const image = this.queuedImage;
    if (!image || this.busy[index] === true) return;
    this.queuedImage = null;
    this.dispatch(index, image);
  }

  private dispatch(index: number, image: ImageData): void {
    this.busy[index] = true;
    this.workers[index]!.postMessage({
      id: this.nextFrameId++,
      mode: this.mode,
      buffer: image.data.buffer,
      width: image.width,
      height: image.height,
    }, [image.data.buffer]);
  }
}
