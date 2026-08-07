import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

interface DecodeRequest {
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

interface DecodeResponse {
  id: number;
  bytes: ArrayBuffer | null;
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
  .then(() => workerScope.postMessage({ id: -1, bytes: null }))
  .catch((cause) => workerScope.postMessage({
    id: -1,
    bytes: null,
    error: cause instanceof Error ? cause.message : String(cause),
  }));

workerScope.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, buffer, width, height } = event.data;
  try {
    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const results = await readBarcodes(image, {
      formats: ["QRCode"],
      maxNumberOfSymbols: 1,
      tryHarder: true,
      tryInvert: true,
      tryDenoise: true,
    });
    const result = results.find((candidate) => candidate.isValid && candidate.bytes.length > 0);
    if (!result) {
      workerScope.postMessage({ id, bytes: null });
      return;
    }
    const bytes = Uint8Array.from(result.bytes);
    const output = bytes.buffer as ArrayBuffer;
    workerScope.postMessage({ id, bytes: output }, [output]);
  } catch (cause) {
    workerScope.postMessage({
      id,
      bytes: null,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
