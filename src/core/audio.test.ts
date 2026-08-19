import { describe, expect, it } from "vitest";
import { AudioFrameDecoder, encodeAudioFrame } from "./audio";

describe("audio carrier", () => {
  it("round-trips a frame through generated PCM in irregular chunks", () => {
    const frame = Uint8Array.from({ length: 88 }, (_value, index) => (index * 53 + 17) & 0xff);
    const pcm = encodeAudioFrame(frame, "fast");
    const received: Uint8Array[] = [];
    const decoder = new AudioFrameDecoder((bytes) => received.push(bytes));
    let offset = 0;
    let chunk = 317;
    while (offset < pcm.length) {
      decoder.feed(pcm.subarray(offset, Math.min(pcm.length, offset + chunk)));
      offset += chunk;
      chunk = chunk === 317 ? 911 : 317;
    }
    expect(received, JSON.stringify(decoder.diagnostics())).toHaveLength(1);
    expect(received[0]).toEqual(frame);
  });

  it("rejects a damaged audio packet", () => {
    const frame = Uint8Array.from({ length: 72 }, (_value, index) => (index * 29 + 3) & 0xff);
    const pcm = encodeAudioFrame(frame, "stable");
    const start = Math.floor(pcm.length * 0.62);
    pcm.fill(0, start, Math.min(pcm.length, start + 2500));
    const received: Uint8Array[] = [];
    const decoder = new AudioFrameDecoder((bytes) => received.push(bytes));
    decoder.feed(pcm);
    expect(received).toHaveLength(0);
  });

  it("round-trips through speaker and microphone distortion", () => {
    const frame = Uint8Array.from({ length: 88 }, (_value, index) => (index * 41 + 9) & 0xff);
    const source = encodeAudioFrame(frame, "stable");
    const pcm = new Float32Array(source.length);
    let random = 0x44595453;
    for (let index = 0; index < source.length; index++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const noise = (random / 0xffffffff - 0.5) * 0.006;
      pcm[index] = source[index]! * 0.32
        + (index >= 288 ? source[index - 288]! * 0.15 : 0)
        + (index >= 672 ? source[index - 672]! * 0.08 : 0)
        + noise;
    }
    const received: Uint8Array[] = [];
    const decoder = new AudioFrameDecoder((bytes) => received.push(bytes));
    for (let offset = 0; offset < pcm.length; offset += 1024) {
      decoder.feed(pcm.subarray(offset, Math.min(pcm.length, offset + 1024)));
    }
    expect(received, JSON.stringify(decoder.diagnostics())).toHaveLength(1);
    expect(received[0]).toEqual(frame);
  });
});
