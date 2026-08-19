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

export function renderColorQr(canvas: HTMLCanvasElement, frames: readonly Uint8Array[], ecc: QrEcc): RenderedQr {
  if (frames.length !== 3) throw new Error("彩色二维码需要三个数据帧");
  const matrices = frames.map((frame) => createQrMatrix(frame, ecc));
  const first = matrices[0]!;
  if (matrices.some((matrix) => matrix.version !== first.version || matrix.modules !== first.modules)) {
    throw new Error("彩色二维码的三个数据帧版本不一致");
  }

  const requestedSize = Math.max(480, Math.min(960, canvas.clientWidth || 720));
  const margin = 4;
  const totalModules = first.modules + margin * 2;
  const scale = Math.max(1, Math.floor(requestedSize / totalModules));
  const size = totalModules * scale;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法创建二维码画布");
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);

  for (let row = 0; row < first.modules; row++) {
    for (let column = 0; column < first.modules; column++) {
      const index = row * first.modules + column;
      const red = matrices[0]!.data[index] ? 16 : 240;
      const green = matrices[1]!.data[index] ? 16 : 240;
      const blue = matrices[2]!.data[index] ? 16 : 240;
      context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
      context.fillRect((column + margin) * scale, (row + margin) * scale, scale, scale);
    }
  }

  return { version: first.version, modules: first.modules };
}
