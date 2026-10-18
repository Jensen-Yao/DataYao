import { crc32, bytesEqual, sha256 } from "./checksum";
import { gzip, gunzip } from "fflate";

export const FRAME_HEADER_SIZE = 24;
export const FRAME_HEADER_SIZE_V2 = 26;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_CONTAINER_BYTES = MAX_FILE_BYTES + 1024 * 1024;
export const MIN_BLOCK_SIZE = 256;
// QR version 40 with ECC-L carries 2953 payload bytes; the largest frame
// (v2 header + block) must stay below that so dense frames stay scannable.
export const MAX_BLOCK_SIZE = 2920;
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_VERSION_V2 = 2;

export function frameHeaderSize(version: number): number {
  return version >= PROTOCOL_VERSION_V2 ? FRAME_HEADER_SIZE_V2 : FRAME_HEADER_SIZE;
}

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
  if (bytes.length > MAX_FILE_BYTES) throw new Error("文件超过 256 MB 限制");

  const fileName = safeName(name);
  const type = mimeType || "application/octet-stream";
  const originalHash = await sha256(bytes);
  let data = bytes;
  let compressed = false;
  if (bytes.length >= 512) {
    // fflate's async gzip runs on its own worker pool so large files
    // do not freeze the sender UI.
    const gzipped = await new Promise<Uint8Array>((resolve, reject) => {
      gzip(bytes, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result)));
    });
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
  if (originalLength > MAX_FILE_BYTES) throw new Error("恢复文件超过 256 MB 限制");
  const metadataEnd = CONTAINER_HEADER_SIZE + nameLength + typeLength;
  if (metadataEnd > container.length) throw new Error("传输容器元数据损坏");
  const decoder = new TextDecoder();
  const fileName = safeName(decoder.decode(container.subarray(CONTAINER_HEADER_SIZE, CONTAINER_HEADER_SIZE + nameLength)));
  const mimeType = decoder.decode(container.subarray(CONTAINER_HEADER_SIZE + nameLength, metadataEnd)) || "application/octet-stream";
  let bytes = container.subarray(metadataEnd);
  if ((flags & 1) !== 0) {
    try {
      bytes = await new Promise<Uint8Array>((resolve, reject) => {
        gunzip(bytes, (error, result) => (error ? reject(error) : resolve(result)));
      });
    } catch {
      throw new Error("压缩数据无法解压");
    }
  }
  if (bytes.length !== originalLength) throw new Error("恢复文件长度校验失败");
  const expectedHash = container.subarray(14, 46);
  const actualHash = await sha256(bytes);
  if (!bytesEqual(expectedHash, actualHash)) throw new Error("SHA-256 校验失败，数据可能损坏");
  return { fileName, mimeType, bytes, isText: (flags & 2) !== 0, compressed: (flags & 1) !== 0 };
}

export function packFrame(header: FrameHeader, block: Uint8Array): Uint8Array {
  if (header.blockCount < 1) throw new RangeError("blockCount 超出协议范围");
  // v1 keeps blockCount in a u16; larger streams automatically upgrade to the
  // v2 frame header (u32 blockCount) while receivers accept both layouts.
  const version = header.blockCount > 0xffff ? PROTOCOL_VERSION_V2 : PROTOCOL_VERSION;
  const headerSize = frameHeaderSize(version);
  const frame = new Uint8Array(headerSize + header.blockSize);
  const view = new DataView(frame.buffer);
  frame[0] = FRAME_MAGIC_0;
  frame[1] = FRAME_MAGIC_1;
  frame[2] = version;
  frame[3] = header.flags & 0xff;
  writeU32(view, 4, header.sessionId);
  writeU32(view, 8, header.sequence);
  if (version === PROTOCOL_VERSION_V2) {
    writeU32(view, 12, header.blockCount);
    writeU16(view, 16, header.blockSize);
    writeU32(view, 18, header.totalLength);
    writeU32(view, 22, header.payloadCrc);
  } else {
    if (header.blockCount > 0xffff) throw new RangeError("blockCount 超出 v1 协议范围");
    writeU16(view, 12, header.blockCount);
    writeU16(view, 14, header.blockSize);
    writeU32(view, 16, header.totalLength);
    writeU32(view, 20, header.payloadCrc);
  }
  frame.set(block.subarray(0, header.blockSize), headerSize);
  return frame;
}

export function parseFrame(bytes: Uint8Array): ParsedFrame | null {
  if (bytes.length < FRAME_HEADER_SIZE || bytes[0] !== FRAME_MAGIC_0 || bytes[1] !== FRAME_MAGIC_1) return null;
  const version = bytes[2]!;
  if (version !== PROTOCOL_VERSION && version !== PROTOCOL_VERSION_V2) return null;
  const headerSize = frameHeaderSize(version);
  if (bytes.length < headerSize) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let blockCount: number;
  let blockSize: number;
  let totalLength: number;
  let payloadCrc: number;
  if (version === PROTOCOL_VERSION_V2) {
    blockCount = view.getUint32(12, true);
    blockSize = readU16(view, 16);
    totalLength = view.getUint32(18, true);
    payloadCrc = view.getUint32(22, true);
  } else {
    blockCount = readU16(view, 12);
    blockSize = readU16(view, 14);
    totalLength = view.getUint32(16, true);
    payloadCrc = view.getUint32(20, true);
  }
  const header: FrameHeader = {
    flags: bytes[3]!,
    sessionId: readU32(view, 4),
    sequence: readU32(view, 8),
    blockCount,
    blockSize,
    totalLength,
    payloadCrc
  };
  if (header.blockCount < 1 || header.blockSize < 1 || header.totalLength < 1 || header.totalLength > MAX_CONTAINER_BYTES) return null;
  if (header.totalLength > header.blockCount * header.blockSize || header.totalLength <= (header.blockCount - 1) * header.blockSize) return null;
  if (bytes.length !== headerSize + header.blockSize) return null;
  return { header, block: bytes.subarray(headerSize) };
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
