const CRC_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  CRC_TABLE[i] = value >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffffffff) >>> 0;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = Uint8Array.from(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
