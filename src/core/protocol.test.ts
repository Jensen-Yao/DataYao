import { describe, expect, it } from "vitest";
import { packFrame, packTransfer, parseFrame, unpackTransfer } from "./protocol";

describe("DataYao protocol", () => {
  it("rejects a frame whose total length cannot fit its source blocks", () => {
    const frame = new Uint8Array(24 + 1000);
    frame.set([0x44, 0x59, 1, 0], 0);
    const view = new DataView(frame.buffer);
    view.setUint32(4, 1, true);
    view.setUint32(8, 0, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, 1000, true);
    view.setUint32(16, 0xffffffff, true);
    expect(parseFrame(frame)).toBeNull();
  });

  it("round-trips compressed metadata and verifies the frame shape", async () => {
    const source = new TextEncoder().encode("DataYao offline transfer ".repeat(100));
    const packed = await packTransfer("notes.txt", "text/plain", source, true);
    const frame = packFrame({
      flags: 1,
      sessionId: 9,
      sequence: 2,
      blockCount: 1,
      blockSize: packed.container.length,
      totalLength: packed.container.length,
      payloadCrc: 0,
    }, packed.container);
    expect(parseFrame(frame)?.header.sequence).toBe(2);
    await expect(unpackTransfer(packed.container)).resolves.toMatchObject({ fileName: "notes.txt", isText: true });
  });
});
