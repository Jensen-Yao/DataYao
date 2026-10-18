import { createQrMatrix } from "../core/colorQr";
import { LTEncoder } from "../core/fountain";
import { makeFrameHeader, packFrame } from "../core/protocol";
import type { QrEcc } from "../core/qr";

interface InitMessage {
  kind: "init";
  container: ArrayBuffer;
  blockSize: number;
  sessionId: number;
  flags: number;
  channels: 1 | 3;
  ecc: QrEcc;
}

interface AdvanceMessage {
  kind: "advance";
  ticks: number;
}

type Request = InitMessage | AdvanceMessage;

export interface RenderJobMessage {
  sequence: number;
  channels: 1 | 3;
  version: number;
  modules: number;
  matrices: ArrayBuffer[];
}

// Owns the fountain encoder, frame CRC and QR matrix generation for the
// optical sender. The main thread only composes matrices into pixels, so
// dense color frames at high fps no longer compete with React and compositing
// on the UI thread, and large payloads never block it.
let encoder: LTEncoder | null = null;
let header: ReturnType<typeof makeFrameHeader> | null = null;
let settings: { channels: 1 | 3; ecc: QrEcc } | null = null;
let sequence = 0;

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.kind === "init") {
    const container = new Uint8Array(request.container);
    encoder = new LTEncoder(container, request.blockSize, request.sessionId);
    header = makeFrameHeader(container, request.blockSize, request.sessionId, request.flags);
    settings = { channels: request.channels, ecc: request.ecc };
    sequence = 0;
    return;
  }
  if (!encoder || !header || !settings) return;
  const { channels, ecc } = settings;
  for (let tick = 0; tick < request.ticks; tick++) {
    const matrices: ArrayBuffer[] = [];
    let version = 0;
    let modules = 0;
    for (let channel = 0; channel < channels; channel++) {
      const block = encoder.encode(sequence + channel);
      const frame = packFrame({ ...header, sequence: sequence + channel }, block);
      const matrix = createQrMatrix(frame, ecc);
      version = matrix.version;
      modules = matrix.modules;
      // matrix.data is a fresh standalone buffer per frame; transferring it
      // to the main thread costs no additional copy.
      matrices.push(matrix.data.buffer as ArrayBuffer);
    }
    sequence += channels;
    (self as unknown as {
      postMessage: (message: RenderJobMessage, transfer?: Transferable[]) => void;
    }).postMessage({ sequence: sequence - channels, channels, version, modules, matrices }, matrices);
  }
};

