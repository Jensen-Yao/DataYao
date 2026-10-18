import QrRenderWorker from "../workers/qrRender.worker?worker";
import type { RenderJobMessage } from "../workers/qrRender.worker";
import type { QrMatrix } from "./colorQr";
import type { QrEcc } from "./qr";

export interface QrRenderJob {
  sequence: number;
  version: number;
  modules: number;
  matrices: QrMatrix[];
}

const LOW_WATER = 6;
const HIGH_WATER = 30;

// Feeds pre-generated QR matrix jobs to the sender UI thread. The render
// worker runs ahead of the display frame rate; poll() hands the next job to
// the rAF loop and tops the worker back up as the queue drains.
export class QrFrameFactory {
  private worker: Worker | null = null;
  private readonly queue: QrRenderJob[] = [];
  private pendingTicks = 0;
  private disposed = false;

  start(container: Uint8Array, blockSize: number, sessionId: number, flags: number, channels: 1 | 3, ecc: QrEcc, onError?: (message: string) => void): void {
    this.dispose();
    this.disposed = false;
    this.queue.length = 0;
    this.pendingTicks = 0;
    const worker = new QrRenderWorker();
    worker.onmessage = (event: MessageEvent<RenderJobMessage>) => {
      if (this.disposed || event.target !== worker) return;
      this.pendingTicks -= 1;
      const job = event.data;
      this.queue.push({
        sequence: job.sequence,
        version: job.version,
        modules: job.modules,
        matrices: job.matrices.map((buffer) => ({
          version: job.version,
          modules: job.modules,
          data: new Uint8Array(buffer),
        })),
      });
      this.refill();
    };
    worker.onerror = (event) => {
      if (this.disposed) return;
      this.disposed = true;
      onError?.(event.message || "二维码渲染 Worker 运行失败");
    };
    this.worker = worker;
    // Transfer the buffer so the worker takes ownership without an extra
    // structured-clone copy of the payload.
    const buffer = container.slice().buffer as ArrayBuffer;
    worker.postMessage({
      kind: "init",
      container: buffer,
      blockSize,
      sessionId,
      flags,
      channels,
      ecc,
    }, [buffer]);
    this.refill();
  }

  poll(): QrRenderJob | null {
    const job = this.queue.shift() ?? null;
    this.refill();
    return job;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.pendingTicks = 0;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.terminate();
    }
  }

  private refill(): void {
    if (!this.worker || this.disposed) return;
    const deficit = HIGH_WATER - this.queue.length - this.pendingTicks;
    if (deficit <= 0) return;
    this.pendingTicks += deficit;
    this.worker.postMessage({ kind: "advance", ticks: deficit });
  }
}
