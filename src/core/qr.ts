import { createQrMatrix } from "./colorQr";

export type QrEcc = "L" | "M" | "Q" | "H";

export interface RenderedQr {
  version: number;
  modules: number;
}

export function renderQr(canvas: HTMLCanvasElement, bytes: Uint8Array, ecc: QrEcc): RenderedQr {
  const qr = createQrMatrix(bytes, ecc);
  const requestedSize = Math.max(480, Math.min(960, canvas.clientWidth || 720));
  const margin = 4;
  const totalModules = qr.modules + margin * 2;
  const scale = Math.max(1, Math.floor(requestedSize / totalModules));
  const size = totalModules * scale;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法创建二维码画布");
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#071018";
  for (let row = 0; row < qr.modules; row++) {
    for (let column = 0; column < qr.modules; column++) {
      if (!qr.data[row * qr.modules + column]) continue;
      context.fillRect((column + margin) * scale, (row + margin) * scale, scale, scale);
    }
  }
  return { version: qr.version, modules: qr.modules };
}
