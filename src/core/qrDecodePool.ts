import QrDecodeWorker from "../workers/qrDecode.worker?worker";

interface DecodeResponse {
  id: number;
  bytes: ArrayBuffer | null;
  error?: string;
}

export class QrDecodePool {
  private readonly workers: Worker[] = [];
  private readonly busy: boolean[] = [];
  private nextFrameId = 0;
  private completedFrames = 0;

  constructor(
    count: number,
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
        if (event.data.bytes) this.onDecoded(new Uint8Array(event.data.bytes));
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

  submit(image: ImageData): boolean {
    const index = this.busy.indexOf(false);
    if (index < 0) return false;
    this.busy[index] = true;
    this.workers[index]!.postMessage({
      id: this.nextFrameId++,
      buffer: image.data.buffer,
      width: image.width,
      height: image.height,
    }, [image.data.buffer]);
    return true;
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.busy.length = 0;
  }
}
