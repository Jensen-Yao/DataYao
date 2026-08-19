import { describe, expect, it } from "vitest";
import { createQrMatrix } from "./colorQr";

describe("color QR carrier", () => {
  it("keeps three equal-length frames on the same QR grid", () => {
    const frames = [11, 37, 83].map((salt) => Uint8Array.from(
      { length: 824 },
      (_value, index) => (index * salt + 19) & 0xff,
    ));
    const matrices = frames.map((frame) => createQrMatrix(frame, "L"));
    expect(new Set(matrices.map((matrix) => matrix.version)).size).toBe(1);
    expect(new Set(matrices.map((matrix) => matrix.modules)).size).toBe(1);
    expect(matrices[0]!.data).not.toEqual(matrices[1]!.data);
  });
});
