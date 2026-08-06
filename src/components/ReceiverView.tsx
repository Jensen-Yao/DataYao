import { useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import { Camera, CheckCircle2, Copy, Download, RefreshCw, ScanLine, Square } from "lucide-react";
import { crc32 } from "../core/checksum";
import { LTDecoder } from "../core/fountain";
import { parseFrame, streamKey, unpackTransfer, type TransferResult } from "../core/protocol";

interface ReceiveStats {
  validFrames: number;
  duplicateFrames: number;
  solvedBlocks: number;
  blockCount: number;
  startedAt: number;
}

const EMPTY_STATS: ReceiveStats = { validFrames: 0, duplicateFrames: 0, solvedBlocks: 0, blockCount: 0, startedAt: 0 };

export function ReceiverView() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("摄像头未启动");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<ReceiveStats>(EMPTY_STATS);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const decoderRef = useRef<LTDecoder | null>(null);
  const streamKeyRef = useRef("");
  const completedRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    let frameHandle = 0;
    let cancelled = false;
    let lastStatsAt = 0;

    const scan = async (now: number) => {
      if (cancelled || completedRef.current) return;
      const video = videoRef.current;
      const canvas = scanCanvasRef.current;
      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const sourceSize = Math.min(video.videoWidth, video.videoHeight);
        const scanSize = Math.min(960, sourceSize);
        canvas.width = scanSize;
        canvas.height = scanSize;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context) {
          const sourceX = (video.videoWidth - sourceSize) / 2;
          const sourceY = (video.videoHeight - sourceSize) / 2;
          context.drawImage(video, sourceX, sourceY, sourceSize, sourceSize, 0, 0, scanSize, scanSize);
          const image = context.getImageData(0, 0, scanSize, scanSize);
          const decoded = jsQR(image.data, scanSize, scanSize, { inversionAttempts: "dontInvert" });
          if (decoded?.binaryData?.length) {
            try {
              await acceptFrame(Uint8Array.from(decoded.binaryData));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }
        }
      }
      if (now - lastStatsAt > 250) {
        const decoder = decoderRef.current;
        if (decoder) {
          setStats((current) => ({
            ...current,
            validFrames: decoder.framesNew,
            duplicateFrames: decoder.framesDuplicate,
            solvedBlocks: decoder.solvedCount,
            blockCount: decoder.blockCount,
          }));
        }
        lastStatsAt = now;
      }
      frameHandle = requestAnimationFrame(scan);
    };

    async function acceptFrame(bytes: Uint8Array) {
      const parsed = parseFrame(bytes);
      if (!parsed) return;
      const key = streamKey(parsed.header);
      if (key !== streamKeyRef.current) {
        decoderRef.current = new LTDecoder(
          parsed.header.blockCount,
          parsed.header.blockSize,
          parsed.header.sessionId,
          parsed.header.totalLength,
        );
        streamKeyRef.current = key;
        setStats({ ...EMPTY_STATS, blockCount: parsed.header.blockCount, startedAt: performance.now() });
        setStatus("已锁定数据流");
        setError("");
      }
      const decoder = decoderRef.current!;
      decoder.add(parsed.header.sequence, parsed.block);
      if (!decoder.complete) return;
      const container = decoder.assemble();
      if (!container || crc32(container) !== parsed.header.payloadCrc) throw new Error("CRC32 校验失败");
      completedRef.current = true;
      const unpacked = await unpackTransfer(container);
      setResult(unpacked);
      setStatus("接收完成");
      setStats((current) => ({ ...current, validFrames: decoder.framesNew, duplicateFrames: decoder.framesDuplicate, solvedBlocks: decoder.solvedCount }));
      stopCamera();
    }

    frameHandle = requestAnimationFrame(scan);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameHandle);
    };
  }, [running]);

  async function startCamera() {
    setError("");
    setResult(null);
    completedRef.current = false;
    decoderRef.current = null;
    streamKeyRef.current = "";
    setStats(EMPTY_STATS);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前页面不是安全上下文，摄像头需要 HTTPS");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 1280 },
          frameRate: { ideal: 30, max: 60 }
        }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const available = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
      setDevices(available);
      const activeDevice = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (activeDevice) setDeviceId(activeDevice);
      setRunning(true);
      setStatus("正在搜索数据流");
      if (navigator.wakeLock) {
        wakeLockRef.current = await navigator.wakeLock.request("screen").catch(() => null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("摄像头启动失败");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setRunning(false);
  }

  function resetReceiver() {
    stopCamera();
    setResult(null);
    setError("");
    setStatus("摄像头未启动");
    setStats(EMPTY_STATS);
    decoderRef.current = null;
    streamKeyRef.current = "";
    completedRef.current = false;
  }

  const expectedFrames = stats.blockCount ? Math.ceil(stats.blockCount * 1.2) : 0;
  const frameProgress = expectedFrames ? stats.validFrames / expectedFrames : 0;
  const blockProgress = stats.blockCount ? stats.solvedBlocks / stats.blockCount : 0;
  const progress = result ? 1 : Math.min(0.99, Math.max(frameProgress * 0.92, blockProgress));
  const elapsed = stats.startedAt ? Math.max(0.1, (performance.now() - stats.startedAt) / 1000) : 0;
  const rate = elapsed ? stats.validFrames / elapsed : 0;

  return (
    <div className="workspace-grid">
      <section className="control-rail" aria-label="接收设置">
        <div className="section-heading">
          <h1>接收</h1>
          <p>启动摄像头并对准发送屏幕。</p>
        </div>

        <label className="camera-select">
          <span>摄像头</span>
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} disabled={running}>
            <option value="">自动选择后置摄像头</option>
            {devices.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || `摄像头 ${index + 1}`}</option>
            ))}
          </select>
        </label>

        <div className="receiver-status">
          <ScanLine size={22} />
          <div><span>状态</span><strong>{status}</strong></div>
        </div>

        <div className="progress-block">
          <div className="progress-label"><span>恢复进度</span><strong>{Math.round(progress * 100)}%</strong></div>
          <div className="progress-track"><div style={{ width: `${progress * 100}%` }} /></div>
        </div>

        <dl className="receive-metrics">
          <div><dt>有效帧</dt><dd>{stats.validFrames}</dd></div>
          <div><dt>重复帧</dt><dd>{stats.duplicateFrames}</dd></div>
          <div><dt>恢复块</dt><dd>{stats.blockCount ? `${stats.solvedBlocks}/${stats.blockCount}` : "—"}</dd></div>
          <div><dt>解码速率</dt><dd>{rate ? `${rate.toFixed(1)} fps` : "—"}</dd></div>
        </dl>

        {error && <div className="error-message" role="alert">{error}</div>}

        <div className="primary-actions">
          {!running && !result && (
            <button className="primary-button" type="button" onClick={startCamera}>
              <Camera size={18} /> 启动摄像头
            </button>
          )}
          {running && (
            <button className="stop-button" type="button" onClick={stopCamera}>
              <Square size={17} fill="currentColor" /> 停止扫描
            </button>
          )}
          {result && (
            <button className="secondary-button" type="button" onClick={resetReceiver}>
              <RefreshCw size={17} /> 接收下一项
            </button>
          )}
        </div>
      </section>

      <section className="visual-stage receiver-stage" aria-label="摄像头接收画面">
        <div className="stage-toolbar">
          <div><span className={`status-dot ${running ? "live" : result ? "complete" : ""}`} />{result ? "校验通过" : running ? "正在扫描" : "等待摄像头"}</div>
        </div>

        {!result ? (
          <div className="camera-shell">
            <video ref={videoRef} muted playsInline />
            <canvas ref={scanCanvasRef} hidden />
            {!running && <div className="camera-placeholder"><Camera size={42} /><span>摄像头画面</span></div>}
            {running && <div className="scan-guide" aria-hidden="true"><i /><i /><i /><i /></div>}
          </div>
        ) : (
          <ResultPanel result={result} />
        )}
      </section>
    </div>
  );
}

function ResultPanel({ result }: { result: TransferResult }) {
  const text = result.isText ? new TextDecoder().decode(result.bytes) : "";
  const url = useMemo(() => URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: result.mimeType })), [result.bytes, result.mimeType]);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  async function copyText() {
    await navigator.clipboard.writeText(text);
  }

  return (
    <div className="result-panel">
      <CheckCircle2 size={54} />
      <h2>{result.isText ? "文本接收完成" : "文件接收完成"}</h2>
      <p>{result.fileName} · {formatBytes(result.bytes.length)} · SHA-256 verified</p>
      {result.isText && <pre>{text}</pre>}
      <div className="result-actions">
        {result.isText ? (
          <button className="primary-button" type="button" onClick={copyText}><Copy size={17} /> 复制文本</button>
        ) : (
          <a className="primary-button" href={url} download={result.fileName}><Download size={17} /> 保存文件</a>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
