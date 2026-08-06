import { crc32, bytesEqual, sha256 } from "./checksum";
import { gzipSync, gunzipSync } from "fflate";

export const FRAME_HEADER_SIZE = 24;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_CONTAINER_BYTES = MAX_FILE_BYTES + 64 * 1024;
export const MIN_BLOCK_SIZE = 256;
export const MAX_BLOCK_SIZE = 2400;
export const PROTOCOL_VERSION = 1;

const FRAME_MAGIC_0 = 0x44;
const FRAME_MAGIC_1 = 0x59;
const CONTAINER_MAGIC = new Uint8Array([0x44, 0x59, 0x43, 0x31]);
const CONTAINER_HEADER_SIZE = 46;

export interface FrameHeader {
  sessionId: number;
  sequence: number;
  blockCount: number;
  blockSize: number;
  totalLength: number;
  payloadCrc: number;
  flags: number;
}

export interface ParsedFrame { header: FrameHeader; block: Uint8Array }

export interface TransferPayload {
  container: Uint8Array;
  fileName: string;
  mimeType: string;
  originalBytes: Uint8Array;
  transmittedBytes: number;
  compressed: boolean;
  isText: boolean;
}

export interface TransferResult {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  isText: boolean;
  compressed: boolean;
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  return base && base !== "." && base !== ".." ? base : "datayao-transfer.bin";
}

function writeU16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function writeU32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true); }
function readU16(view: DataView, offset: number): number { return view.getUint16(offset, true); }
function readU32(view: DataView, offset: number): number { return view.getUint32(offset, true); }

export async function packTransfer(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  isText = false,
): Promise<TransferPayload> {
  if (bytes.length === 0) throw new Error("不能传输空文件");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("文件超过 64 MB 限制");

  const fileName = safeName(name);
  const type = mimeType || "application/octet-stream";
  const originalHash = await sha256(bytes);
  let data = bytes;
  let compressed = false;
  if (bytes.length >= 512) {
    const gzipped = gzipSync(bytes, { level: 6 });
    if (gzipped.length + 16 < bytes.length) {
      data = gzipped;
      compressed = true;
    }
  }

  const nameBytes = new TextEncoder().encode(fileName);
  const typeBytes = new TextEncoder().encode(type);
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) throw new Error("文件元数据过长");
  const container = new Uint8Array(CONTAINER_HEADER_SIZE + nameBytes.length + typeBytes.length + data.length);
  const view = new DataView(container.buffer);
  container.set(CONTAINER_MAGIC, 0);
  container[4] = 1;
  container[5] = (compressed ? 1 : 0) | (isText ? 2 : 0);
  writeU16(view, 6, nameBytes.length);
  writeU16(view, 8, typeBytes.length);
  writeU32(view, 10, bytes.length);
  container.set(originalHash, 14);
  container.set(nameBytes, CONTAINER_HEADER_SIZE);
  container.set(typeBytes, CONTAINER_HEADER_SIZE + nameBytes.length);
  container.set(data, CONTAINER_HEADER_SIZE + nameBytes.length + typeBytes.length);
  if (container.length > MAX_CONTAINER_BYTES) throw new Error("传输容器超过安全上限");

  return {
    container,
    fileName,
    mimeType: type,
    originalBytes: bytes,
    transmittedBytes: data.length,
    compressed,
    isText
  };
}

export async function unpackTransfer(container: Uint8Array): Promise<TransferResult> {
  if (container.length < CONTAINER_HEADER_SIZE || container.length > MAX_CONTAINER_BYTES) {
    throw new Error("传输容器长度无效");
  }
  if (!bytesEqual(container.subarray(0, 4), CONTAINER_MAGIC) || container[4] !== 1) {
    throw new Error("不支持的 DataYao 容器");
  }
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const flags = container[5]!;
  const nameLength = readU16(view, 6);
  const typeLength = readU16(view, 8);
  const originalLength = readU32(view, 10);
  if (originalLength > MAX_FILE_BYTES) throw new Error("恢复文件超过 64 MB 限制");
  const metadataEnd = CONTAINER_HEADER_SIZE + nameLength + typeLength;
  if (metadataEnd > container.length) throw new Error("传输容器元数据损坏");
  const decoder = new TextDecoder();
  const fileName = safeName(decoder.decode(container.subarray(CONTAINER_HEADER_SIZE, CONTAINER_HEADER_SIZE + nameLength)));
  const mimeType = decoder.decode(container.subarray(CONTAINER_HEADER_SIZE + nameLength, metadataEnd)) || "application/octet-stream";
  let bytes = container.subarray(metadataEnd);
  if ((flags & 1) !== 0) {
    try { bytes = gunzipSync(bytes); } catch { throw new Error("压缩数据无法解压"); }
  }
  if (bytes.length !== originalLength) throw new Error("恢复文件长度校验失败");
  const expectedHash = container.subarray(14, 46);
  const actualHash = await sha256(bytes);
  if (!bytesEqual(expectedHash, actualHash)) throw new Error("SHA-256 校验失败，数据可能损坏");
  return { fileName, mimeType, bytes: Uint8Array.from(bytes), isText: (flags & 2) !== 0, compressed: (flags & 1) !== 0 };
}

export function packFrame(header: FrameHeader, block: Uint8Array): Uint8Array {
  if (header.blockCount < 1 || header.blockCount > 0xffff) throw new RangeError("blockCount 超出协议范围");
  const frame = new Uint8Array(FRAME_HEADER_SIZE + header.blockSize);
  const view = new DataView(frame.buffer);
  frame[0] = FRAME_MAGIC_0;
  frame[1] = FRAME_MAGIC_1;
  frame[2] = PROTOCOL_VERSION;
  frame[3] = header.flags & 0xff;
  writeU32(view, 4, header.sessionId);
  writeU32(view, 8, header.sequence);
  writeU16(view, 12, header.blockCount);
  writeU16(view, 14, header.blockSize);
  writeU32(view, 16, header.totalLength);
  writeU32(view, 20, header.payloadCrc);
  frame.set(block.subarray(0, header.blockSize), FRAME_HEADER_SIZE);
  return frame;
}

export function parseFrame(bytes: Uint8Array): ParsedFrame | null {
  if (bytes.length < FRAME_HEADER_SIZE || bytes[0] !== FRAME_MAGIC_0 || bytes[1] !== FRAME_MAGIC_1 || bytes[2] !== PROTOCOL_VERSION) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    flags: bytes[3]!,
    sessionId: readU32(view, 4),
    sequence: readU32(view, 8),
    blockCount: readU16(view, 12),
    blockSize: readU16(view, 14),
    totalLength: readU32(view, 16),
    payloadCrc: readU32(view, 20)
  };
  if (header.blockCount < 1 || header.blockSize < 1 || header.totalLength < 1 || header.totalLength > MAX_CONTAINER_BYTES) return null;
  if (header.totalLength > header.blockCount * header.blockSize || header.totalLength <= (header.blockCount - 1) * header.blockSize) return null;
  if (bytes.length !== FRAME_HEADER_SIZE + header.blockSize) return null;
  return { header, block: bytes.subarray(FRAME_HEADER_SIZE) };
}

export function streamKey(header: FrameHeader): string {
  return [header.sessionId, header.blockCount, header.blockSize, header.totalLength, header.payloadCrc, header.flags].join(":");
}

export function makeFrameHeader(payload: Uint8Array, blockSize: number, sessionId: number, flags: number): FrameHeader {
  return {
    flags,
    sessionId,
    sequence: 0,
    blockCount: Math.max(1, Math.ceil(payload.length / blockSize)),
    blockSize,
    totalLength: payload.length,
    payloadCrc: crc32(payload)
  };
}
