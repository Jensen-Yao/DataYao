import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import jsQR from "jsqr";

describe("QR optical payload", () => {
  it("round-trips a binary frame at the default payload size", () => {
    const payload = new Uint8Array(24 + 1600);
    for (let index = 0; index < payload.length; index++) payload[index] = (index * 37 + 11) & 0xff;
    const qr = QRCode.create(
      [{ data: payload, mode: "byte" } as unknown as QRCode.QRCodeSegment],
      { errorCorrectionLevel: "L", maskPattern: 4 },
    );
    const margin = 4;
    const scale = 5;
    const modules = qr.modules.size + margin * 2;
    const size = modules * scale;
    const pixels = new Uint8ClampedArray(size * size * 4);
    pixels.fill(255);
    for (let row = 0; row < qr.modules.size; row++) {
      for (let column = 0; column < qr.modules.size; column++) {
        if (!qr.modules.data[row * qr.modules.size + column]) continue;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const pixel = (((row + margin) * scale + y) * size + (column + margin) * scale + x) * 4;
            pixels[pixel] = 7;
            pixels[pixel + 1] = 16;
            pixels[pixel + 2] = 24;
            pixels[pixel + 3] = 255;
          }
        }
      }
    }
    const decoded = jsQR(pixels, size, size, { inversionAttempts: "dontInvert" });
    expect(decoded).not.toBeNull();
    expect(Uint8Array.from(decoded!.binaryData)).toEqual(payload);
  });
});
