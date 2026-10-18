import { describe, expect, it } from "vitest";
import {
  FRAME_HEADER_SIZE,
  FRAME_HEADER_SIZE_V2,
  packFrame,
  packTransfer,
  parseFrame,
  unpackTransfer,
  type FrameHeader,
} from "./protocol";

function syntheticBlock(size: number): Uint8Array {
  const block = new Uint8Array(size);
  for (let index = 0; index < size; index++) block[index] = index & 0xff;
  return block;
}

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

  it("emits a v1 header while blockCount fits in a u16", () => {
    const header: FrameHeader = {
      flags: 0,
      sessionId: 7,
      sequence: 3,
      blockCount: 0xffff,
      blockSize: 1200,
      totalLength: 0xffff * 1200,
      payloadCrc: 123456,
    };
    const frame = packFrame(header, syntheticBlock(1200));
    expect(frame.length).toBe(FRAME_HEADER_SIZE + 1200);
    const parsed = parseFrame(frame);
    expect(parsed?.header.blockCount).toBe(0xffff);
    expect(parsed?.header.blockSize).toBe(1200);
    expect(parsed?.header.totalLength).toBe(header.totalLength);
    expect(parsed?.header.payloadCrc).toBe(123456);
    expect(parsed?.block.length).toBe(1200);
  });

  it("upgrades to the v2 header with a u32 blockCount for large streams", () => {
    const blockCount = 0xffff + 1;
    const header: FrameHeader = {
      flags: 0,
      sessionId: 0x12345678,
      sequence: 0x89abcdef,
      blockCount,
      blockSize: 1200,
      totalLength: blockCount * 1200,
      payloadCrc: 0xdeadbeef,
    };
    const frame = packFrame(header, syntheticBlock(1200));
    expect(frame.length).toBe(FRAME_HEADER_SIZE_V2 + 1200);
    expect(frame[2]).toBe(2);
    const parsed = parseFrame(frame);
    expect(parsed?.header.blockCount).toBe(blockCount);
    expect(parsed?.header.sessionId).toBe(0x12345678);
    expect(parsed?.header.sequence).toBe(0x89abcdef);
    expect(parsed?.header.payloadCrc).toBe(0xdeadbeef);
    expect(parsed?.block[0]).toBe(0);
    expect(parsed?.block[1199]).toBe(1199 & 0xff);
  });

  it("rejects unknown protocol versions but keeps v1 and v2 frames parseable", () => {
    const header: FrameHeader = {
      flags: 0,
      sessionId: 1,
      sequence: 0,
      blockCount: 10,
      blockSize: 256,
      totalLength: 2560,
      payloadCrc: 1,
    };
    const frame = packFrame(header, syntheticBlock(256));
    expect(frame[2]).toBe(1);
    expect(parseFrame(frame)).not.toBeNull();
    const future = frame.slice();
    future[2] = 3;
    expect(parseFrame(future)).toBeNull();
  });
});
