import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, Copy, Download, RefreshCw, ScanLine, Square } from "lucide-react";
import { crc32 } from "../core/checksum";
import { LTDecoder } from "../core/fountain";
import { parseFrame, streamKey, unpackTransfer, type TransferResult } from "../core/protocol";
import { QrDecodePool } from "../core/qrDecodePool";

interface ReceiveStats {
  validFrames: number;
  duplicateFrames: number;
  solvedBlocks: number;
  blockCount: number;
  startedAt: number;
}

const EMPTY_STATS: ReceiveStats = { validFrames: 0, duplicateFrames: 0, solvedBlocks: 0, blockCount: 0, startedAt: 0 };
type ScanPhase = "idle" | "searching" | "no-camera-frame" | "no-qr" | "invalid-qr" | "decoder-error" | "locked" | "complete";

interface ScanActivity {
  capturedFrames: number;
  analyzedFrames: number;
  droppedFrames: number;
  workerCount: number;
}

const EMPTY_ACTIVITY: ScanActivity = { capturedFrames: 0, analyzedFrames: 0, droppedFrames: 0, workerCount: 0 };

interface NativeSaveBridge {
  saveFileStart: (message: string) => void;
  saveFileChunk: (message: string) => void;
  saveFileFinish: (message: string) => void;
}

interface HarmonyBridge extends NativeSaveBridge {
  requestCameraPermission: () => void;
  copyText: (message: string) => void;
}

interface AndroidBridge extends NativeSaveBridge {}

interface HarmonyResultDetail {
  ok: boolean;
  message: string;
}

function getHarmonyBridge(): HarmonyBridge | null {
  return (window as Window & { DataYaoHarmony?: HarmonyBridge }).DataYaoHarmony ?? null;
}

function getAndroidBridge(): AndroidBridge | null {
  return (window as Window & { DataYaoAndroid?: AndroidBridge }).DataYaoAndroid ?? null;
}

function getNativeSaveBridge(): NativeSaveBridge | null {
  return getHarmonyBridge() ?? getAndroidBridge();
}

function requestHarmonyCameraPermission(): Promise<void> {
  const bridge = getHarmonyBridge();
  if (!bridge) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("datayao-harmony-camera-permission", onResult);
      window.clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<CameraPermissionDetail>).detail;
      if (detail?.granted) finish();
      else finish(new Error(detail?.message || "摄像头权限未授予"));
    };
    const timeout = window.setTimeout(() => finish(new Error("鸿蒙摄像头授权响应超时")), 15_000);
    window.addEventListener("datayao-harmony-camera-permission", onResult);
    bridge.requestCameraPermission();
  });
}

interface CameraPermissionDetail {
  granted: boolean;
  message?: string;
}

type VideoFrameElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number;
};

type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[] };
type FocusConstraintSet = MediaTrackConstraintSet & { focusMode?: string };

export function ReceiverView() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("摄像头未启动");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<ReceiveStats>(EMPTY_STATS);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const [qrDetections, setQrDetections] = useState(0);
  const [scanActivity, setScanActivity] = useState<ScanActivity>(EMPTY_ACTIVITY);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement>(null);
  const receiverStageRef = useRef<HTMLElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const decoderRef = useRef<LTDecoder | null>(null);
  const streamKeyRef = useRef("");
  const completedRef = useRef(false);
  const scanStartedAtRef = useRef(0);
  const lastQrAtRef = useRef(0);
  const lastDiagnosticAtRef = useRef(0);
  const invalidQrFramesRef = useRef(0);
  const qrDetectionsRef = useRef(0);
  const capturedFramesRef = useRef(0);
  const droppedFramesRef = useRef(0);
  const decoderErrorRef = useRef("");

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let animationFrameHandle = 0;
    let videoFrameHandle = 0;
    const scanContext = scanCanvasRef.current?.getContext("2d", { willReadFrequently: true }) ?? null;
    const pool = new QrDecodePool(
      2,
      (bytes) => {
        if (cancelled || completedRef.current) return;
        const now = performance.now();
        lastQrAtRef.current = now;
        qrDetectionsRef.current += 1;
        void acceptFrame(bytes).then((accepted) => {
          if (accepted || decoderRef.current) return;
          invalidQrFramesRef.current += 1;
          setScanPhase("invalid-qr");
          setStatus("二维码不是 DataYao 帧");
          if (invalidQrFramesRef.current === 1 || now - lastDiagnosticAtRef.current > 3000) {
            setError("解码器已识别到二维码，但内容不是 DataYao 数据帧。请确认发送端正在播放 DataYao。");
            lastDiagnosticAtRef.current = now;
          }
        }).catch((cause) => {
          setScanPhase("invalid-qr");
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      },
      (message) => {
        if (cancelled) return;
        decoderErrorRef.current = message;
        setScanPhase("decoder-error");
        setStatus("二维码解码器异常");
        setError(`ZXing 解码器运行失败：${message}`);
      },
    );

    const captureFrame = () => {
      if (cancelled || completedRef.current) return;
      const video = videoRef.current;
      const canvas = scanCanvasRef.current;
      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        capturedFramesRef.current += 1;
        if (pool.busyCount >= pool.size) {
          droppedFramesRef.current += 1;
          return;
        }
        const scanWidth = video.videoWidth;
        const scanHeight = video.videoHeight;
        if (canvas.width !== scanWidth || canvas.height !== scanHeight) {
          canvas.width = scanWidth;
          canvas.height = scanHeight;
        }
        if (scanContext) {
          scanContext.drawImage(video, 0, 0, scanWidth, scanHeight);
          const image = scanContext.getImageData(0, 0, scanWidth, scanHeight);
          if (!pool.submit(image)) droppedFramesRef.current += 1;
        }
      }
    };

    const video = videoRef.current as VideoFrameElement | null;
    const scheduleVideoFrame = () => {
      if (cancelled || completedRef.current) return;
      if (video?.requestVideoFrameCallback) {
        videoFrameHandle = video.requestVideoFrameCallback(() => {
          captureFrame();
          scheduleVideoFrame();
        });
      } else {
        animationFrameHandle = requestAnimationFrame(() => {
          captureFrame();
          scheduleVideoFrame();
        });
      }
    };

    const diagnosticsTimer = window.setInterval(() => {
      if (cancelled) return;
      const now = performance.now();
      const video = videoRef.current;
      setQrDetections(qrDetectionsRef.current);
      setScanActivity({
        capturedFrames: capturedFramesRef.current,
        analyzedFrames: pool.completedCount,
        droppedFrames: droppedFramesRef.current,
        workerCount: pool.size,
      });
      if (scanStartedAtRef.current && now - scanStartedAtRef.current > 8000 && now - lastDiagnosticAtRef.current > 3000) {
        const hasVideoFrame = Boolean(video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0);
        if (!hasVideoFrame || capturedFramesRef.current === 0) {
          setScanPhase("no-camera-frame");
          setStatus("摄像头没有视频帧");
          setError("摄像头已打开，但没有收到视频帧。请检查系统权限、摄像头占用情况或更换摄像头。");
          lastDiagnosticAtRef.current = now;
        } else if (decoderErrorRef.current) {
          setScanPhase("decoder-error");
          setStatus("二维码解码器异常");
          setError(`摄像头画面正常，但 ZXing 解码器失败：${decoderErrorRef.current}`);
          lastDiagnosticAtRef.current = now;
        } else if (pool.completedCount === 0) {
          setScanPhase("decoder-error");
          setStatus("二维码解码器没有响应");
          setError("摄像头画面正常，但 ZXing 解码器在 8 秒内没有返回结果。请重启接收端；若仍出现，请检查安装包是否完整包含 WASM 文件。");
          lastDiagnosticAtRef.current = now;
        } else if (!lastQrAtRef.current) {
          setScanPhase("no-qr");
          setStatus("未识别到二维码");
          setError("摄像头和解码器均在工作，但未识别到二维码。请让二维码完整占画面宽度的 40%–80%，避免反光，并将发送速度降到 10–15 fps、每帧 800–1200 B。");
          lastDiagnosticAtRef.current = now;
        }
      }
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
    }, 250);

    async function acceptFrame(bytes: Uint8Array): Promise<boolean> {
      const parsed = parseFrame(bytes);
      if (!parsed) return false;
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
        setScanPhase("locked");
        setStatus("已锁定数据流");
        setError("");
      }
      const decoder = decoderRef.current!;
      decoder.add(parsed.header.sequence, parsed.block);
      if (!decoder.complete) return true;
      const container = decoder.assemble();
      if (!container || crc32(container) !== parsed.header.payloadCrc) throw new Error("CRC32 校验失败");
      completedRef.current = true;
      const unpacked = await unpackTransfer(container);
      setResult(unpacked);
      setScanPhase("complete");
      setStatus("接收完成");
      setStats((current) => ({ ...current, validFrames: decoder.framesNew, duplicateFrames: decoder.framesDuplicate, solvedBlocks: decoder.solvedCount }));
      stopCamera();
      return true;
    }

    scheduleVideoFrame();
    return () => {
      cancelled = true;
      window.clearInterval(diagnosticsTimer);
      if (animationFrameHandle) cancelAnimationFrame(animationFrameHandle);
      if (videoFrameHandle && video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameHandle);
      pool.terminate();
    };
  }, [running]);

  async function startCamera() {
    setError("");
    setResult(null);
    completedRef.current = false;
    decoderRef.current = null;
    streamKeyRef.current = "";
    setStats(EMPTY_STATS);
    setScanPhase("searching");
    setQrDetections(0);
    setScanActivity(EMPTY_ACTIVITY);
    lastQrAtRef.current = 0;
    lastDiagnosticAtRef.current = 0;
    invalidQrFramesRef.current = 0;
    qrDetectionsRef.current = 0;
    capturedFramesRef.current = 0;
    droppedFramesRef.current = 0;
    decoderErrorRef.current = "";
    try {
      await requestHarmonyCameraPermission();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前页面不是安全上下文，摄像头需要 HTTPS");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 960 },
          frameRate: { ideal: 30, max: 60 }
        }
      });
      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack?.getCapabilities) {
        const capabilities = videoTrack.getCapabilities() as FocusCapabilities;
        if (capabilities.focusMode?.includes("continuous")) {
          await videoTrack.applyConstraints({
            advanced: [{ focusMode: "continuous" } as FocusConstraintSet],
          }).catch(() => undefined);
        }
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const available = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
      setDevices(available);
      const activeDevice = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (activeDevice) setDeviceId(activeDevice);
      scanStartedAtRef.current = performance.now();
      setRunning(true);
      setStatus("正在搜索数据流");
      window.requestAnimationFrame(() => {
        receiverStageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
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
    scanStartedAtRef.current = 0;
    setRunning(false);
  }

  function resetReceiver() {
    stopCamera();
    setResult(null);
    setError("");
    setStatus("摄像头未启动");
    setScanPhase("idle");
    setQrDetections(0);
    setScanActivity(EMPTY_ACTIVITY);
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
    <div className={`workspace-grid receiver-workspace${running ? " is-running" : ""}`}>
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
        {running && (
          <div className="scan-diagnostics" aria-live="polite">
            <span>{scanPhaseLabel(scanPhase)}</span>
            <small>采集 {scanActivity.capturedFrames} · 分析 {scanActivity.analyzedFrames} · 二维码 {qrDetections}</small>
            <small>{scanActivity.workerCount} 个解码线程 · 忙时丢帧 {scanActivity.droppedFrames}</small>
          </div>
        )}

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

      <section className="visual-stage receiver-stage" ref={receiverStageRef} aria-label="摄像头接收画面">
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

function scanPhaseLabel(phase: ScanPhase): string {
  switch (phase) {
    case "searching": return "正在分析摄像头画面";
    case "no-camera-frame": return "摄像头没有提供视频帧";
    case "no-qr": return "没有识别到二维码";
    case "invalid-qr": return "二维码格式不匹配";
    case "decoder-error": return "ZXing 解码器运行失败";
    case "locked": return "已锁定 DataYao 数据流";
    case "complete": return "数据流恢复完成";
    default: return "等待扫描";
  }
}

function ResultPanel({ result }: { result: TransferResult }) {
  const text = result.isText ? new TextDecoder().decode(result.bytes) : "";
  const url = useMemo(() => URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: result.mimeType })), [result.bytes, result.mimeType]);
  const [feedback, setFeedback] = useState("");

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    const onSaveResult = (event: Event) => {
      const detail = (event as CustomEvent<HarmonyResultDetail>).detail;
      if (detail?.message) setFeedback(detail.message);
    };
    const onCopyResult = (event: Event) => {
      const detail = (event as CustomEvent<HarmonyResultDetail>).detail;
      if (detail?.message) setFeedback(detail.message);
    };
    window.addEventListener("datayao-harmony-save-result", onSaveResult);
    window.addEventListener("datayao-harmony-copy-result", onCopyResult);
    window.addEventListener("datayao-android-save-result", onSaveResult);
    return () => {
      window.removeEventListener("datayao-harmony-save-result", onSaveResult);
      window.removeEventListener("datayao-harmony-copy-result", onCopyResult);
      window.removeEventListener("datayao-android-save-result", onSaveResult);
    };
  }, []);

  async function copyText() {
    const bridge = getHarmonyBridge();
    if (bridge) {
      setFeedback("正在复制…");
      bridge.copyText(JSON.stringify({ text }));
      return;
    }
    await navigator.clipboard.writeText(text);
    setFeedback("已复制到剪贴板");
  }

  async function saveFile() {
    const bridge = getNativeSaveBridge();
    if (!bridge) return;
    setFeedback("正在准备保存…");
    bridge.saveFileStart(JSON.stringify({ name: result.fileName, mimeType: result.mimeType, size: result.bytes.length }));
    const chunkSize = 192 * 1024;
    for (let offset = 0; offset < result.bytes.length; offset += chunkSize) {
      const chunk = result.bytes.subarray(offset, Math.min(offset + chunkSize, result.bytes.length));
      bridge.saveFileChunk(JSON.stringify({ base64: encodeBase64(chunk) }));
      if (offset > 0 && offset % (chunkSize * 8) === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    bridge.saveFileFinish("{}");
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
        ) : getNativeSaveBridge() ? (
          <button className="primary-button" type="button" onClick={() => void saveFile()}><Download size={17} /> 保存文件</button>
        ) : (
          <a className="primary-button" href={url} download={result.fileName}><Download size={17} /> 保存文件</a>
        )}
      </div>
      {feedback && <p className="save-feedback" role="status">{feedback}</p>}
    </div>
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  }
  return btoa(binary);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
