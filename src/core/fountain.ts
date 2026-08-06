// Deterministic LT fountain coding for a one-way screen-to-camera channel.
// The sender and receiver derive the same block subset from (session, seq),
// so frames can arrive in any order and dropped frames only cost time.

const LN2 = 0.6931471805599453;
const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;

export function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let value = state ^ (state >>> 16);
    value = Math.imul(value, 0x21f0aaad);
    value ^= value >>> 15;
    value = Math.imul(value, 0x735a2d97);
    value ^= value >>> 15;
    return value >>> 0;
  };
}

// Deterministic log approximation keeps the wire format stable across JS engines.
function dlog(value: number): number {
  let exponent = 0;
  let mantissa = value;
  while (mantissa >= 1.5) {
    mantissa /= 2;
    exponent++;
  }
  while (mantissa < 0.75) {
    mantissa *= 2;
    exponent--;
  }
  const z = (mantissa - 1) / (mantissa + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let n = 1; n <= 21; n += 2) {
    sum += term / n;
    term *= z2;
  }
  return exponent * LN2 + 2 * sum;
}

export function solitonCdf(k: number): Float64Array {
  const cdf = new Float64Array(k);
  if (k <= 1) {
    cdf[0] = 1;
    return cdf;
  }
  const radius = Math.max(1, SOLITON_C * dlog(k / SOLITON_DELTA) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / radius));
  let total = 0;
  for (let degree = 1; degree <= k; degree++) {
    const rho = degree === 1 ? 1 / k : 1 / (degree * (degree - 1));
    let tau = 0;
    if (degree < spike) tau = radius / (degree * k);
    else if (degree === spike) tau = (radius * Math.max(0, dlog(radius / SOLITON_DELTA))) / k;
    total += rho + tau;
    cdf[degree - 1] = total;
  }
  for (let index = 0; index < k; index++) cdf[index] = cdf[index]! / total;
  cdf[k - 1] = 1;
  return cdf;
}

function frameSeed(sessionId: number, sequence: number): number {
  let hash = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (sequence + 0x85ebca6b)) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) | 0;
}

export function frameIndices(k: number, cdf: Float64Array, sessionId: number, sequence: number): number[] {
  const random = splitmix32(frameSeed(sessionId, sequence));
  const unit = random() * 2 ** -32;
  let low = 0;
  let high = k - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cdf[middle]! >= unit) high = middle;
    else low = middle + 1;
  }
  const degree = Math.min(k, low + 1);
  if (degree > k >> 3) {
    const scratch = new Uint32Array(k);
    for (let index = 0; index < k; index++) scratch[index] = index;
    const output = new Array<number>(degree);
    for (let index = 0; index < degree; index++) {
      const swapIndex = index + (random() % (k - index));
      const temp = scratch[index]!;
      scratch[index] = scratch[swapIndex]!;
      scratch[swapIndex] = temp;
      output[index] = scratch[index]!;
    }
    return output;
  }
  const selected = new Set<number>();
  while (selected.size < degree) selected.add(random() % k);
  return [...selected];
}

function xorInto(destination: Uint8Array, source: Uint8Array): void {
  for (let index = 0; index < destination.length; index++) {
    destination[index] = destination[index]! ^ source[index]!;
  }
}

export class LTEncoder {
  readonly blockCount: number;
  private readonly blocks: Uint8Array[];
  private readonly cdf: Float64Array;

  constructor(readonly payload: Uint8Array, readonly blockSize: number, readonly sessionId: number) {
    if (!Number.isInteger(blockSize) || blockSize < 64) throw new RangeError("blockSize must be at least 64 bytes");
    this.blockCount = Math.max(1, Math.ceil(payload.length / blockSize));
    this.blocks = Array.from({ length: this.blockCount }, (_, index) => {
      const block = new Uint8Array(blockSize);
      block.set(payload.subarray(index * blockSize, (index + 1) * blockSize));
      return block;
    });
    this.cdf = solitonCdf(this.blockCount);
  }

  encode(sequence: number): Uint8Array {
    const output = new Uint8Array(this.blockSize);
    for (const blockIndex of frameIndices(this.blockCount, this.cdf, this.sessionId, sequence)) {
      xorInto(output, this.blocks[blockIndex]!);
    }
    return output;
  }
}

interface PendingFrame { indices: Set<number>; data: Uint8Array }

export class LTDecoder {
  private readonly cdf: Float64Array;
  private readonly solved: Array<Uint8Array | null>;
  private readonly waiting = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  solvedCount = 0;
  framesNew = 0;
  framesDuplicate = 0;

  constructor(readonly blockCount: number, readonly blockSize: number, readonly sessionId: number, readonly totalLength: number) {
    if (blockCount < 1 || blockCount > 0xffff) throw new RangeError("invalid block count");
    if (totalLength < 1 || totalLength > blockCount * blockSize || totalLength <= (blockCount - 1) * blockSize) {
      throw new RangeError("inconsistent fountain dimensions");
    }
    this.cdf = solitonCdf(blockCount);
    this.solved = new Array<Uint8Array | null>(blockCount).fill(null);
  }

  get complete(): boolean { return this.solvedCount === this.blockCount; }

  add(sequence: number, data: Uint8Array): void {
    if (this.seen.has(sequence)) {
      this.framesDuplicate++;
      return;
    }
    this.seen.add(sequence);
    this.framesNew++;
    if (this.complete) return;

    const indices = new Set(frameIndices(this.blockCount, this.cdf, this.sessionId, sequence));
    const reduced = Uint8Array.from(data.subarray(0, this.blockSize));
    for (const index of [...indices]) {
      const solved = this.solved[index];
      if (solved) {
        xorInto(reduced, solved);
        indices.delete(index);
      }
    }
    if (indices.size === 0) return;
    if (indices.size === 1) {
      this.resolve(indices.values().next().value!, reduced);
      return;
    }
    const pending: PendingFrame = { indices, data: reduced };
    for (const index of indices) {
      const bucket = this.waiting.get(index) ?? new Set<PendingFrame>();
      bucket.add(pending);
      this.waiting.set(index, bucket);
    }
  }

  assemble(): Uint8Array | null {
    if (!this.complete) return null;
    const output = new Uint8Array(this.totalLength);
    for (let index = 0; index < this.blockCount; index++) {
      const start = index * this.blockSize;
      const length = Math.min(this.blockSize, this.totalLength - start);
      output.set(this.solved[index]!.subarray(0, length), start);
    }
    return output;
  }

  private resolve(index: number, data: Uint8Array): void {
    const queue: Array<[number, Uint8Array]> = [[index, data]];
    while (queue.length > 0) {
      const [resolvedIndex, resolvedData] = queue.pop()!;
      if (this.solved[resolvedIndex]) continue;
      this.solved[resolvedIndex] = resolvedData;
      this.solvedCount++;
      const bucket = this.waiting.get(resolvedIndex);
      if (!bucket) continue;
      this.waiting.delete(resolvedIndex);
      for (const pending of bucket) {
        xorInto(pending.data, resolvedData);
        pending.indices.delete(resolvedIndex);
        if (pending.indices.size === 1) {
          const next = pending.indices.values().next().value!;
          this.waiting.get(next)?.delete(pending);
          if (!this.solved[next]) queue.push([next, pending.data]);
        }
      }
    }
  }
}
