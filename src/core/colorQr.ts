import QRCode from "qrcode";
import type { QrEcc, RenderedQr } from "./qr";

export interface QrMatrix {
  version: number;
  modules: number;
  data: Uint8Array;
}

export function createQrMatrix(bytes: Uint8Array, ecc: QrEcc): QrMatrix {
  const qr = QRCode.create(
    [{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment],
    { errorCorrectionLevel: ecc, maskPattern: 4 },
  );
  return {
    version: qr.version,
    modules: qr.modules.size,
    data: Uint8Array.from(qr.modules.data),
  };
}

const QR_MARGIN = 4;

// One scratch canvas per module count: the module-resolution image is painted
// here once, then upscaled with a single GPU drawImage call. This replaces the
// previous per-module fillRect loop (tens of thousands of calls per frame).
const moduleCanvasCache = new Map<number, HTMLCanvasElement>();

function moduleCanvas(modules: number): HTMLCanvasElement {
  let canvas = moduleCanvasCache.get(modules);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = modules;
    canvas.height = modules;
    if (moduleCanvasCache.size > 8) moduleCanvasCache.clear();
    moduleCanvasCache.set(modules, canvas);
  }
  return canvas;
}

function paintMatrix(image: ImageData, matrix: QrMatrix): void {
  const pixels = image.data;
  const data = matrix.data;
  const modules = matrix.modules;
  for (let index = 0; index < modules * modules; index++) {
    const offset = index * 4;
    const value = data[index] ? 16 : 240;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
}

function paintColorMatrices(image: ImageData, matrices: readonly QrMatrix[]): void {
  const pixels = image.data;
  const first = matrices[0]!;
  const data = matrices.map((matrix) => matrix.data);
  const modules = first.modules;
  for (let index = 0; index < modules * modules; index++) {
    const offset = index * 4;
    pixels[offset] = data[0]![index] ? 16 : 240;
    pixels[offset + 1] = data[1]![index] ? 16 : 240;
    pixels[offset + 2] = data[2]![index] ? 16 : 240;
    pixels[offset + 3] = 255;
  }
}

function upscaleToCanvas(canvas: HTMLCanvasElement, modules: number): CanvasRenderingContext2D | null {
  const requestedSize = Math.max(480, Math.min(960, canvas.clientWidth || 720));
  const totalModules = modules + QR_MARGIN * 2;
  const scale = Math.max(1, Math.floor(requestedSize / totalModules));
  const size = totalModules * scale;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  return context;
}

export function renderMatrixToCanvas(canvas: HTMLCanvasElement, matrices: readonly QrMatrix[]): RenderedQr {
  if (matrices.length === 0) throw new Error("渲染二维码需要至少一个矩阵");
  const first = matrices[0]!;
  if (matrices.some((matrix) => matrix.version !== first.version || matrix.modules !== first.modules)) {
    throw new Error("彩色二维码的三个数据帧版本不一致");
  }
  const context = upscaleToCanvas(canvas, first.modules);
  if (!context) throw new Error("无法创建二维码画布");
  const scratch = moduleCanvas(first.modules);
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true })!;
  const image = scratchContext.createImageData(first.modules, first.modules);
  if (matrices.length === 1) {
    paintMatrix(image, first);
  } else if (matrices.length === 3) {
    paintColorMatrices(image, matrices);
  } else {
    throw new Error("彩色二维码需要三个数据帧");
  }
  scratchContext.putImageData(image, 0, 0);
  const scale = canvas.width / (first.modules + QR_MARGIN * 2);
  const targetSize = first.modules * scale;
  context.drawImage(scratch, QR_MARGIN * scale, QR_MARGIN * scale, targetSize, targetSize);
  return { version: first.version, modules: first.modules };
}

export function renderColorQr(canvas: HTMLCanvasElement, frames: readonly Uint8Array[], ecc: QrEcc): RenderedQr {
  if (frames.length !== 3) throw new Error("彩色二维码需要三个数据帧");
  return renderMatrixToCanvas(canvas, frames.map((frame) => createQrMatrix(frame, ecc)));
}
