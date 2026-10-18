import { createQrMatrix, renderMatrixToCanvas, type QrMatrix } from "./colorQr";

export type QrEcc = "L" | "M" | "Q" | "H";

export interface RenderedQr {
  version: number;
  modules: number;
}

export function renderQr(canvas: HTMLCanvasElement, bytes: Uint8Array, ecc: QrEcc): RenderedQr {
  return renderMatrixToCanvas(canvas, [createQrMatrix(bytes, ecc)]);
}

export { createQrMatrix, renderMatrixToCanvas };
export type { QrMatrix };
