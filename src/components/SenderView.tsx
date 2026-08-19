import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { AudioLines, File as FileIcon, FileText, Maximize2, Play, ScanLine, Square, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { audioFrameDurationMs, encodeAudioFrame, type AudioProfile } from "../core/audio";
import { renderColorQr } from "../core/colorQr";
import { LTEncoder } from "../core/fountain";
import { makeFrameHeader, packFrame, packTransfer, type TransferPayload } from "../core/protocol";
import { renderQr, type QrEcc } from "../core/qr";

const BLOCK_OPTIONS = [800, 1200, 1600, 2000, 2300] as const;
const SOUND_BLOCK_OPTIONS = [64, 96, 128] as const;
const FPS_OPTIONS = [10, 15, 20, 24, 30] as const;
const MAX_FILE_SIZE = 64 * 1024 * 1024;

interface LiveTransfer {
  payload: TransferPayload;
  encoder: LTEncoder;
  header: ReturnType<typeof makeFrameHeader>;
}

type SendCarrierMode = "qr" | "color" | "sound";

export function SenderView() {
  const [sourceMode, setSourceMode] = useState<"file" | "text">("file");
  const [carrier, setCarrier] = useState<SendCarrierMode>("qr");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [blockSize, setBlockSize] = useState(1200);
  const [fps, setFps] = useState(15);
  const [ecc, setEcc] = useState<QrEcc>("L");
  const [audioProfile, setAudioProfile] = useState<AudioProfile>("stable");
  const [transfer, setTransfer] = useState<LiveTransfer | null>(null);
  const [running, setRunning] = useState(false);
  const [frameNumber, setFrameNumber] = useState(0);
  const [qrVersion, setQrVersion] = useState<number | null>(null);
  const [qrScale, setQrScale] = useState(100);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const dragDepthRef = useRef(0);

  const estimatedRate = useMemo(() => {
    if (carrier === "sound") {
      const duration = audioFrameDurationMs(24 + blockSize, audioProfile) / 1000;
      return `${Math.max(1, Math.round(blockSize / 1.2 / duration))} B/s`;
    }
    const channels = carrier === "color" ? 3 : 1;
    return `${Math.round((blockSize * fps * channels) / 1.2 / 1024)} KB/s`;
  }, [audioProfile, blockSize, carrier, fps]);

  useEffect(() => {
    if (!running || !transfer || carrier === "sound" || !canvasRef.current) return;
    let animationFrame = 0;
    let sequence = 0;
    let nextFrameAt = performance.now();
    let lastUiUpdate = 0;
    const interval = 1000 / fps;

    const tick = (now: number) => {
      if (now >= nextFrameAt && canvasRef.current) {
        try {
          const channelCount = carrier === "color" ? 3 : 1;
          const frames = Array.from({ length: channelCount }, (_value, index) => {
            const frameSequence = sequence + index;
            const block = transfer.encoder.encode(frameSequence);
            return packFrame({ ...transfer.header, sequence: frameSequence }, block);
          });
          const rendered = carrier === "color"
            ? renderColorQr(canvasRef.current, frames, ecc)
            : renderQr(canvasRef.current, frames[0]!, ecc);
          setQrVersion(rendered.version);
          sequence += channelCount;
          nextFrameAt = Math.max(nextFrameAt + interval, now + interval * 0.35);
          if (now - lastUiUpdate > 300) {
            setFrameNumber(sequence);
            lastUiUpdate = now;
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRunning(false);
          return;
        }
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [carrier, ecc, fps, running, transfer]);

  useEffect(() => {
    if (!running || !transfer || carrier !== "sound") return;
    let cancelled = false;
    let sequence = 0;
    const context = audioContextRef.current;
    if (!context) {
      setError("声音引擎未启动，请停止后重试");
      setRunning(false);
      return;
    }

    const loop = async () => {
      while (!cancelled) {
        const block = transfer.encoder.encode(sequence);
        const frame = packFrame({ ...transfer.header, sequence }, block);
        const pcm = encodeAudioFrame(frame, audioProfile, context.sampleRate);
        const buffer = context.createBuffer(1, pcm.length, context.sampleRate);
        buffer.copyToChannel(new Float32Array(pcm), 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        audioSourceRef.current = source;
        await new Promise<void>((resolve) => {
          source.onended = () => resolve();
          source.start();
        });
        if (cancelled) break;
        sequence++;
        setFrameNumber(sequence);
      }
    };
    void loop().catch((cause) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setRunning(false);
    });
    return () => {
      cancelled = true;
      try { audioSourceRef.current?.stop(); } catch { /* already stopped */ }
      audioSourceRef.current = null;
    };
  }, [audioProfile, carrier, running, transfer]);

  useEffect(() => () => {
    try { audioSourceRef.current?.stop(); } catch { /* already stopped */ }
    void audioContextRef.current?.close().catch(() => undefined);
  }, []);

  async function startTransfer() {
    setError("");
    try {
      if (carrier === "sound") {
        const context = audioContextRef.current ?? new AudioContext();
        audioContextRef.current = context;
        await context.resume();
      }
      let bytes: Uint8Array;
      let name: string;
      let mime: string;
      let isText = false;
      if (sourceMode === "file") {
        if (!file) throw new Error("请选择文件");
        bytes = new Uint8Array(await file.arrayBuffer());
        name = file.name;
        mime = file.type || "application/octet-stream";
      } else {
        if (!text.trim()) throw new Error("请输入要发送的文本");
        bytes = new TextEncoder().encode(text);
        name = "datayao-text.txt";
        mime = "text/plain;charset=utf-8";
        isText = true;
      }
      if (carrier === "sound" && bytes.length > 64 * 1024) {
        throw new Error("声音模式约为每秒 8–12 字节，仅适合 64 KB 内的短数据；较大内容请使用 QR 模式");
      }
      const payload = await packTransfer(name, mime, bytes, isText);
      const sessionId = crypto.getRandomValues(new Uint32Array(1))[0]! || 1;
      const encoder = new LTEncoder(payload.container, blockSize, sessionId);
      if (encoder.blockCount > 0xffff) throw new Error("当前帧容量不足，请提高每帧字节数");
      const header = makeFrameHeader(payload.container, blockSize, sessionId, isText ? 1 : 0);
      setTransfer({ payload, encoder, header });
      setFrameNumber(0);
      setQrVersion(null);
      setRunning(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function stopTransfer() {
    try { audioSourceRef.current?.stop(); } catch { /* already stopped */ }
    audioSourceRef.current = null;
    setRunning(false);
  }

  function selectCarrier(next: SendCarrierMode) {
    if (running || next === carrier) return;
    setCarrier(next);
    setBlockSize(next === "sound" ? 64 : 1200);
    setFrameNumber(0);
    setQrVersion(null);
    setError(next === "sound" && file && file.size > 64 * 1024
      ? "当前文件超过声音模式的 64 KB 限制，请改用 QR 模式"
      : "");
  }

  function chooseFile(candidate: File | undefined) {
    if (!candidate) return;
    const limit = carrier === "sound" ? 64 * 1024 : MAX_FILE_SIZE;
    if (candidate.size > limit) {
      setError(carrier === "sound" ? "声音模式文件不能超过 64 KB" : "文件不能超过 64 MB");
      return;
    }
    setError("");
    setFile(candidate);
  }

  function handleDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (running) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!running) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (running) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (running) return;
    chooseFile(event.dataTransfer.files?.[0]);
  }

  async function enterFullscreen() {
    await stageRef.current?.requestFullscreen?.();
  }

  const selectedLabel = sourceMode === "file" ? file?.name : text.trim() ? `${new TextEncoder().encode(text).length} 字节文本` : "";
  const blockOptions = carrier === "sound" ? SOUND_BLOCK_OPTIONS : BLOCK_OPTIONS;

  return (
    <div className="workspace-grid">
      <section className="control-rail" aria-label="发送设置">
        <div className="section-heading">
          <h1>发送</h1>
          <p>{carrier === "sound" ? "选择内容并通过声音传输。" : "选择内容并开始播放。"}</p>
        </div>

        <div className="carrier-switch" role="tablist" aria-label="发送方式">
          <button type="button" className={carrier === "qr" ? "active" : ""} onClick={() => selectCarrier("qr")} disabled={running}>
            <ScanLine size={16} /> QR
          </button>
          <button type="button" className={carrier === "color" ? "active color" : "color"} onClick={() => selectCarrier("color")} disabled={running}>
            <span className="color-swatch" aria-hidden="true" /> 彩色 QR
          </button>
          <button type="button" className={carrier === "sound" ? "active sound" : "sound"} onClick={() => selectCarrier("sound")} disabled={running}>
            <AudioLines size={16} /> 声音
          </button>
        </div>

        <div className="source-switch" role="tablist" aria-label="内容类型">
          <button className={sourceMode === "file" ? "active" : ""} onClick={() => setSourceMode("file")} type="button">
            <FileIcon size={17} /> 文件
          </button>
          <button className={sourceMode === "text" ? "active" : ""} onClick={() => setSourceMode("text")} type="button">
            <FileText size={17} /> 文本
          </button>
        </div>

        {sourceMode === "file" ? (
          <label
            className={`file-drop${dragActive ? " is-dragging" : ""}${running ? " is-disabled" : ""}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            aria-disabled={running}
          >
            <Upload size={24} />
            <span>{file ? file.name : "选择或拖入文件"}</span>
            <small>{file ? formatBytes(file.size) : carrier === "sound" ? "最大 64 KB" : "最大 64 MB"}</small>
            <input type="file" disabled={running} onChange={(event) => chooseFile(event.target.files?.[0])} />
          </label>
        ) : (
          <label className="text-source">
            <span>文本内容</span>
            <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4 * 1024 * 1024} />
          </label>
        )}

        <div className="settings-grid">
          <label>
            <span>每帧字节</span>
            <select value={blockSize} onChange={(event) => setBlockSize(Number(event.target.value))} disabled={running}>
              {blockOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {carrier === "sound" ? <label>
            <span>声音速度</span>
            <select value={audioProfile} onChange={(event) => setAudioProfile(event.target.value as AudioProfile)} disabled={running}>
              <option value="stable">稳定</option>
              <option value="fast">快速</option>
            </select>
          </label> : <label>
            <span>播放帧率</span>
            <select value={fps} onChange={(event) => setFps(Number(event.target.value))} disabled={running}>
              {FPS_OPTIONS.map((value) => <option key={value} value={value}>{value} fps</option>)}
            </select>
          </label>}
          {carrier !== "sound" && <label>
            <span>二维码纠错</span>
            <select value={ecc} onChange={(event) => setEcc(event.target.value as QrEcc)} disabled={running}>
              <option value="L">L · 快速</option>
              <option value="M">M · 稳定</option>
            </select>
          </label>}
          <div className="readout">
            <span>预计有效速率</span>
            <strong>{estimatedRate}</strong>
          </div>
        </div>

        {error && <div className="error-message" role="alert">{error}</div>}

        <div className="primary-actions">
          {!running ? (
            <button className="primary-button" type="button" onClick={startTransfer} disabled={!selectedLabel}>
              <Play size={18} fill="currentColor" /> 开始发送
            </button>
          ) : (
            <button className="stop-button" type="button" onClick={stopTransfer}>
              <Square size={17} fill="currentColor" /> 停止
            </button>
          )}
        </div>
      </section>

      <section className="visual-stage sender-stage" ref={stageRef} aria-label={carrier === "sound" ? "声音传输" : "动态二维码"}>
        <div className="stage-toolbar">
          <div>
            <span className={`status-dot ${running ? "live" : ""}`} />
            {running ? "正在发送" : "等待开始"}
          </div>
          <button className="icon-button" type="button" onClick={enterFullscreen} title="全屏显示二维码" disabled={!running}>
            <Maximize2 size={19} />
          </button>
        </div>
        {carrier === "sound" ? <div className="sound-shell sender-sound-shell">
          <AudioLines size={64} />
          <strong>{running ? "正在播放声音" : "声音传输待机"}</strong>
          <span>请让接收设备靠近扬声器，保持环境安静。</span>
        </div> : <>
          <div className="qr-shell">
            <canvas ref={canvasRef} aria-label={carrier === "color" ? "DataYao 彩色动态二维码" : "DataYao 动态二维码"} style={{ width: `${qrScale}%` }} />
            {!running && (
              <div className="stage-empty">
                <img src="./logo.jpg" alt="DataYao" />
                <strong>DataYao</strong>
                <span>{carrier === "color" ? "彩色光学传输待机" : "光学传输待机"}</span>
              </div>
            )}
          </div>
          <div className="qr-size-control">
            <ZoomOut size={16} aria-hidden="true" />
            <label htmlFor="qr-scale">二维码大小</label>
            <input
              id="qr-scale"
              type="range"
              min="40"
              max="100"
              step="5"
              value={qrScale}
              onChange={(event) => setQrScale(Number(event.target.value))}
              aria-valuetext={`${qrScale}%`}
            />
            <output htmlFor="qr-scale">{qrScale}%</output>
            <ZoomIn size={16} aria-hidden="true" />
          </div>
        </>}
        <dl className="stage-metrics">
          <div><dt>序列</dt><dd>{frameNumber.toLocaleString()}</dd></div>
          <div><dt>源块</dt><dd>{transfer?.encoder.blockCount.toLocaleString() ?? "—"}</dd></div>
          <div><dt>{carrier === "sound" ? "音频" : "QR"}</dt><dd>{carrier === "sound" ? (running ? "DTMF" : "—") : qrVersion ? `V${qrVersion}-${ecc}` : "—"}</dd></div>
          <div><dt>载荷</dt><dd>{transfer ? formatBytes(transfer.payload.container.length) : "—"}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
