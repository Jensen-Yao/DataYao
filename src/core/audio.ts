import { crc32 } from "./checksum";

export type AudioProfile = "stable" | "fast";

export interface AudioDecoderDiagnostics {
  analyzedWindows: number;
  detectedWindows: number;
  acceptedSymbols: number;
  bufferedSymbols: number;
  syncMatches: number;
  crcFailures: number;
  peakRms: number;
}

export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_SYNC = [0xf, 0x0, 0xf, 0x0, 0xd, 0xa, 0x7, 0xa] as const;
const LOW_FREQUENCIES = [697, 770, 852, 941] as const;
const HIGH_FREQUENCIES = [1209, 1336, 1477, 1633] as const;

interface AudioTiming {
  toneMs: number;
  gapMs: number;
}

const TIMINGS: Record<AudioProfile, AudioTiming> = {
  stable: { toneMs: 20, gapMs: 10 },
  fast: { toneMs: 18, gapMs: 10 },
};

function timing(profile: AudioProfile): AudioTiming {
  return TIMINGS[profile];
}

function writeTone(output: Float32Array, offset: number, sampleRate: number, durationMs: number, low: number, high: number): number {
  const length = Math.round(sampleRate * durationMs / 1000);
  const ramp = Math.min(Math.round(sampleRate * 0.002), Math.floor(length / 4));
  for (let index = 0; index < length && offset + index < output.length; index++) {
    const envelope = ramp > 0
      ? Math.min(1, (index + 1) / ramp, (length - index) / ramp)
      : 1;
    const time = index / sampleRate;
    const value = (Math.sin(2 * Math.PI * low * time) + Math.sin(2 * Math.PI * high * time)) * 0.17 * envelope;
    output[offset + index] = value;
  }
  return offset + length;
}

function writePilot(output: Float32Array, offset: number, sampleRate: number): number {
  const length = Math.round(sampleRate * 180 / 1000);
  const ramp = Math.round(sampleRate * 0.008);
  for (let index = 0; index < length && offset + index < output.length; index++) {
    const envelope = Math.min(1, (index + 1) / ramp, (length - index) / ramp);
    output[offset + index] = Math.sin(2 * Math.PI * 1800 * index / sampleRate) * 0.24 * envelope;
  }
  return offset + length;
}

function framePacket(frame: Uint8Array): Uint8Array {
  if (frame.length < 1 || frame.length > 0xffff) throw new RangeError("音频帧长度超出范围");
  const packet = new Uint8Array(2 + frame.length + 4);
  const view = new DataView(packet.buffer);
  view.setUint16(0, frame.length, false);
  packet.set(frame, 2);
  view.setUint32(2 + frame.length, crc32(frame), false);
  return packet;
}

function packetNibbles(frame: Uint8Array): number[] {
  const packet = framePacket(frame);
  const nibbles: number[] = [...AUDIO_SYNC];
  for (const byte of packet) nibbles.push(byte >>> 4, byte & 0x0f);
  return nibbles;
}

export function audioFrameDurationMs(frameLength: number, profile: AudioProfile): number {
  const nibbleCount = AUDIO_SYNC.length + (2 + frameLength + 4) * 2;
  const { toneMs, gapMs } = timing(profile);
  return 180 + 80 + nibbleCount * (toneMs + gapMs) + 100;
}

export function encodeAudioFrame(frame: Uint8Array, profile: AudioProfile, sampleRate = AUDIO_SAMPLE_RATE): Float32Array {
  const { toneMs, gapMs } = timing(profile);
  const nibbles = packetNibbles(frame);
  const totalMs = audioFrameDurationMs(frame.length, profile);
  const output = new Float32Array(Math.ceil(sampleRate * totalMs / 1000));
  let offset = Math.round(sampleRate * 35 / 1000);
  offset = writePilot(output, offset, sampleRate);
  offset += Math.round(sampleRate * 80 / 1000);
  for (const nibble of nibbles) {
    const low = LOW_FREQUENCIES[(nibble >>> 2) & 3]!;
    const high = HIGH_FREQUENCIES[nibble & 3]!;
    offset = writeTone(output, offset, sampleRate, toneMs, low, high);
    offset += Math.round(sampleRate * gapMs / 1000);
  }
  return output;
}

function goertzel(samples: Float32Array, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let previous = 0;
  let previous2 = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  return Math.max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2);
}

interface ToneDetection {
  symbol: number | null;
  rms: number;
}

function detectNibble(samples: Float32Array, sampleRate: number): ToneDetection {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  if (rms < 0.012) return { symbol: null, rms };

  const lowPower = LOW_FREQUENCIES.map((frequency) => goertzel(samples, frequency, sampleRate));
  const highPower = HIGH_FREQUENCIES.map((frequency) => goertzel(samples, frequency, sampleRate));
  const lowIndex = lowPower.reduce((best, value, index) => value > lowPower[best]! ? index : best, 0);
  const highIndex = highPower.reduce((best, value, index) => value > highPower[best]! ? index : best, 0);
  const low = lowPower[lowIndex]!;
  const high = highPower[highIndex]!;
  const secondLow = lowPower.filter((_value, index) => index !== lowIndex).sort((a, b) => b - a)[0] ?? 0;
  const secondHigh = highPower.filter((_value, index) => index !== highIndex).sort((a, b) => b - a)[0] ?? 0;
  const scale = samples.length * samples.length;
  const lowAmplitude = Math.sqrt(low / scale) * 2;
  const highAmplitude = Math.sqrt(high / scale) * 2;
  if (lowAmplitude < rms * 0.35 || highAmplitude < rms * 0.35) return { symbol: null, rms };
  if (low < secondLow * 1.35 || high < secondHigh * 1.35) return { symbol: null, rms };
  return { symbol: (lowIndex << 2) | highIndex, rms };
}

function findSync(nibbles: number[]): number {
  outer: for (let start = 0; start <= nibbles.length - AUDIO_SYNC.length; start++) {
    for (let index = 0; index < AUDIO_SYNC.length; index++) {
      if (nibbles[start + index] !== AUDIO_SYNC[index]) continue outer;
    }
    return start;
  }
  return -1;
}

export class AudioFrameDecoder {
  private pending = new Float32Array(0);
  private readonly windowSize: number;
  private readonly hopSize: number;
  private candidate: number | null = null;
  private candidateCount = 0;
  private latched = false;
  private silenceCount = 0;
  private lastAccepted: number | null = null;
  private windowsSinceAccepted = Number.MAX_SAFE_INTEGER;
  private acceptedRms = 0;
  private minRmsSinceAccepted = Number.POSITIVE_INFINITY;
  private nibbles: number[] = [];
  private analyzedWindows = 0;
  private detectedWindows = 0;
  private acceptedSymbols = 0;
  private syncMatches = 0;
  private syncLocked = false;
  private crcFailures = 0;
  private peakRms = 0;

  constructor(
    private readonly onFrame: (frame: Uint8Array) => void,
    private readonly onError?: (message: string) => void,
    private readonly sampleRate = AUDIO_SAMPLE_RATE,
  ) {
    this.windowSize = Math.max(256, Math.round(sampleRate * 0.012));
    this.hopSize = Math.max(64, Math.round(sampleRate * 0.004));
  }

  feed(samples: Float32Array): void {
    const combined = new Float32Array(this.pending.length + samples.length);
    combined.set(this.pending);
    combined.set(samples, this.pending.length);
    let offset = 0;
    while (offset + this.windowSize <= combined.length) {
      this.acceptSymbol(detectNibble(combined.subarray(offset, offset + this.windowSize), this.sampleRate));
      offset += this.hopSize;
    }
    this.pending = combined.slice(offset);
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.candidate = null;
    this.candidateCount = 0;
    this.latched = false;
    this.silenceCount = 0;
    this.lastAccepted = null;
    this.windowsSinceAccepted = Number.MAX_SAFE_INTEGER;
    this.acceptedRms = 0;
    this.minRmsSinceAccepted = Number.POSITIVE_INFINITY;
    this.nibbles = [];
    this.analyzedWindows = 0;
    this.detectedWindows = 0;
    this.acceptedSymbols = 0;
    this.syncMatches = 0;
    this.syncLocked = false;
    this.crcFailures = 0;
    this.peakRms = 0;
  }

  diagnostics(): AudioDecoderDiagnostics {
    return {
      analyzedWindows: this.analyzedWindows,
      detectedWindows: this.detectedWindows,
      acceptedSymbols: this.acceptedSymbols,
      bufferedSymbols: this.nibbles.length,
      syncMatches: this.syncMatches,
      crcFailures: this.crcFailures,
      peakRms: this.peakRms,
    };
  }

  private acceptSymbol({ symbol, rms }: ToneDetection): void {
    this.analyzedWindows++;
    if (symbol !== null) this.detectedWindows++;
    this.peakRms = Math.max(this.peakRms, rms);
    if (this.windowsSinceAccepted < Number.MAX_SAFE_INTEGER) this.windowsSinceAccepted++;
    this.minRmsSinceAccepted = Math.min(this.minRmsSinceAccepted, rms);
    if (symbol === null) {
      this.candidate = null;
      this.candidateCount = 0;
      if (this.latched) {
        this.silenceCount++;
        if (this.silenceCount >= 1) {
          this.latched = false;
          this.silenceCount = 0;
        }
      }
      return;
    }
    this.silenceCount = 0;
    if (this.candidate === symbol) this.candidateCount++;
    else {
      this.candidate = symbol;
      this.candidateCount = 1;
    }
    if (this.candidateCount < 2) return;

    const changedTone = this.lastAccepted !== null
      && symbol !== this.lastAccepted
      && this.windowsSinceAccepted >= 5;
    const repeatedAfterGap = this.lastAccepted === symbol
      && this.windowsSinceAccepted >= 6
      && this.minRmsSinceAccepted < this.acceptedRms * 0.55
      && rms > this.minRmsSinceAccepted * 1.6;
    if (this.latched && !changedTone && !repeatedAfterGap) return;

    this.latched = true;
    this.lastAccepted = symbol;
    this.windowsSinceAccepted = 0;
    this.acceptedRms = rms;
    this.minRmsSinceAccepted = rms;
    this.nibbles.push(symbol);
    this.acceptedSymbols++;
    this.parsePackets();
  }

  private parsePackets(): void {
    while (this.nibbles.length >= AUDIO_SYNC.length) {
      const syncAt = findSync(this.nibbles);
      if (syncAt < 0) {
        this.syncLocked = false;
        this.nibbles = this.nibbles.slice(-AUDIO_SYNC.length + 1);
        return;
      }
      if (syncAt > 0) this.nibbles.splice(0, syncAt);
      if (!this.syncLocked) {
        this.syncMatches++;
        this.syncLocked = true;
      }
      if (this.nibbles.length < AUDIO_SYNC.length + 4) return;
      const lengthAt = AUDIO_SYNC.length;
      const frameLength = (this.nibbles[lengthAt]! << 12)
        | (this.nibbles[lengthAt + 1]! << 8)
        | (this.nibbles[lengthAt + 2]! << 4)
        | this.nibbles[lengthAt + 3]!;
      if (frameLength < 1 || frameLength > 8192) {
        this.syncLocked = false;
        this.nibbles.shift();
        continue;
      }
      const packetNibbles = AUDIO_SYNC.length + 4 + frameLength * 2 + 8;
      if (this.nibbles.length < packetNibbles) return;
      const frame = new Uint8Array(frameLength);
      let cursor = AUDIO_SYNC.length + 4;
      for (let index = 0; index < frame.length; index++) {
        frame[index] = (this.nibbles[cursor++]! << 4) | this.nibbles[cursor++]!;
      }
      let expectedCrc = 0;
      for (let index = 0; index < 8; index++) expectedCrc = (expectedCrc << 4) | this.nibbles[cursor++]!;
      this.nibbles.splice(0, packetNibbles);
      this.syncLocked = false;
      if ((crc32(frame) >>> 0) !== (expectedCrc >>> 0)) {
        this.crcFailures++;
        this.onError?.("音频帧校验失败，正在等待下一帧");
        continue;
      }
      this.onFrame(frame);
    }
  }
}
