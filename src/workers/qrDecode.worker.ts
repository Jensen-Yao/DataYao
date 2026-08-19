import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

interface DecodeRequest {
  id: number;
  mode: "qr" | "color";
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

interface DecodeResponse {
  id: number;
  frames: ArrayBuffer[];
  error?: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage: (message: DecodeResponse, transfer?: Transferable[]) => void;
};

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => path.endsWith(".wasm") ? wasmUrl : `${prefix}${path}`,
  },
});

void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .then(() => workerScope.postMessage({ id: -1, frames: [] }))
  .catch((cause) => workerScope.postMessage({
    id: -1,
    frames: [],
    error: cause instanceof Error ? cause.message : String(cause),
  }));

workerScope.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, mode, buffer, width, height } = event.data;
  try {
    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const frames = mode === "color" ? await decodeColor(image) : await decodeQr(image);
    const outputs = frames.map((bytes) => bytes.buffer as ArrayBuffer);
    workerScope.postMessage({ id, frames: outputs }, outputs);
  } catch (cause) {
    workerScope.postMessage({
      id,
      frames: [],
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

async function decodeQr(image: ImageData): Promise<Uint8Array[]> {
  const results = await readBarcodes(image, {
    formats: ["QRCode"],
    maxNumberOfSymbols: 1,
    tryHarder: true,
    tryInvert: true,
    tryDenoise: true,
  });
  const result = results.find((candidate) => candidate.isValid && candidate.bytes.length > 0);
  return result ? [Uint8Array.from(result.bytes)] : [];
}

async function decodeColor(image: ImageData): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = [];
  for (const channel of [0, 1, 2]) {
    const channelImage = toChannelImage(image, channel);
    const decoded = await decodeQr(channelImage);
    for (const frame of decoded) {
      if (!frames.some((existing) => existing.length === frame.length && existing.every((value, index) => value === frame[index]))) {
        frames.push(frame);
      }
    }
  }
  return frames;
}

function toChannelImage(image: ImageData, channel: number): ImageData {
  const pixels = new Uint8ClampedArray(image.data.length);
  for (let index = 0; index < image.data.length; index += 4) {
    const value = image.data[index + channel]!;
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
    pixels[index + 3] = 255;
  }
  return new ImageData(pixels, image.width, image.height);
}
