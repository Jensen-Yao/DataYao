import { describe, expect, it } from "vitest";
import { LTDecoder, LTEncoder } from "./fountain";

function payload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (index * 73 + 19) & 0xff;
  return bytes;
}

describe("LT fountain transfer", () => {
  it("reconstructs an out-of-order stream with dropped frames", () => {
    const source = payload(17_000);
    const encoder = new LTEncoder(source, 320, 0x31415926);
    const decoder = new LTDecoder(encoder.blockCount, encoder.blockSize, 0x31415926, source.length);
    const frames = Array.from({ length: encoder.blockCount * 3 }, (_, sequence) => ({
      sequence,
      data: encoder.encode(sequence),
    })).filter((_, index) => index % 7 !== 0);
    frames.reverse().forEach((frame) => decoder.add(frame.sequence, frame.data));
    expect(decoder.complete).toBe(true);
    expect(decoder.assemble()).toEqual(source);
  });

  it("counts duplicate frames without changing the result", () => {
    const source = payload(4096);
    const encoder = new LTEncoder(source, 256, 42);
    const decoder = new LTDecoder(encoder.blockCount, encoder.blockSize, 42, source.length);
    for (let sequence = 0; sequence < encoder.blockCount * 3 && !decoder.complete; sequence++) {
      const data = encoder.encode(sequence);
      decoder.add(sequence, data);
      decoder.add(sequence, data);
    }
    expect(decoder.complete).toBe(true);
    expect(decoder.framesDuplicate).toBeGreaterThan(0);
    expect(decoder.assemble()).toEqual(source);
  });
});
