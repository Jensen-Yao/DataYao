import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { File as FileIcon, FileText, Maximize2, Play, Square, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { LTEncoder } from "../core/fountain";
import { makeFrameHeader, packFrame, packTransfer, type TransferPayload } from "../core/protocol";
import { renderQr, type QrEcc } from "../core/qr";

const BLOCK_OPTIONS = [800, 1200, 1600, 2000, 2300] as const;
const FPS_OPTIONS = [10, 15, 20, 24, 30] as const;
const MAX_FILE_SIZE = 64 * 1024 * 1024;

interface LiveTransfer {
  payload: TransferPayload;
  encoder: LTEncoder;
  header: ReturnType<typeof makeFrameHeader>;
}

export function SenderView() {
  const [sourceMode, setSourceMode] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [blockSize, setBlockSize] = useState(1200);
  const [fps, setFps] = useState(15);
  const [ecc, setEcc] = useState<QrEcc>("L");
  const [transfer, setTransfer] = useState<LiveTransfer | null>(null);
  const [running, setRunning] = useState(false);
  const [frameNumber, setFrameNumber] = useState(0);
  const [qrVersion, setQrVersion] = useState<number | null>(null);
  const [qrScale, setQrScale] = useState(100);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);

  const estimatedRate = useMemo(() => Math.round((blockSize * fps) / 1.2 / 1024), [blockSize, fps]);

  useEffect(() => {
    if (!running || !transfer || !canvasRef.current) return;
    let animationFrame = 0;
    let sequence = 0;
    let nextFrameAt = performance.now();
    let lastUiUpdate = 0;
    const interval = 1000 / fps;

    const tick = (now: number) => {
      if (now >= nextFrameAt && canvasRef.current) {
        try {
          const block = transfer.encoder.encode(sequence);
          const frame = packFrame({ ...transfer.header, sequence }, block);
          const rendered = renderQr(canvasRef.current, frame, ecc);
          setQrVersion(rendered.version);
          sequence++;
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
  }, [ecc, fps, running, transfer]);

  async function startTransfer() {
    setError("");
    try {
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
    setRunning(false);
  }

  function chooseFile(candidate: File | undefined) {
    if (!candidate) return;
    if (candidate.size > MAX_FILE_SIZE) {
      setError("文件不能超过 64 MB");
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

  return (
    <div className="workspace-grid">
      <section className="control-rail" aria-label="发送设置">
        <div className="section-heading">
          <h1>发送</h1>
          <p>选择内容并开始播放。</p>
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
            <small>{file ? formatBytes(file.size) : "最大 64 MB"}</small>
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
              {BLOCK_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>播放帧率</span>
            <select value={fps} onChange={(event) => setFps(Number(event.target.value))} disabled={running}>
              {FPS_OPTIONS.map((value) => <option key={value} value={value}>{value} fps</option>)}
            </select>
          </label>
          <label>
            <span>二维码纠错</span>
            <select value={ecc} onChange={(event) => setEcc(event.target.value as QrEcc)} disabled={running}>
              <option value="L">L · 快速</option>
              <option value="M">M · 稳定</option>
            </select>
          </label>
          <div className="readout">
            <span>预计有效速率</span>
            <strong>{estimatedRate} KB/s</strong>
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

      <section className="visual-stage sender-stage" ref={stageRef} aria-label="动态二维码">
        <div className="stage-toolbar">
          <div>
            <span className={`status-dot ${running ? "live" : ""}`} />
            {running ? "正在发送" : "等待开始"}
          </div>
          <button className="icon-button" type="button" onClick={enterFullscreen} title="全屏显示二维码" disabled={!running}>
            <Maximize2 size={19} />
          </button>
        </div>
        <div className="qr-shell">
          <canvas ref={canvasRef} aria-label="DataYao 动态二维码" style={{ width: `${qrScale}%` }} />
          {!running && (
            <div className="stage-empty">
              <img src="./logo.jpg" alt="DataYao" />
              <strong>DataYao</strong>
              <span>光学传输待机</span>
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
        <dl className="stage-metrics">
          <div><dt>序列</dt><dd>{frameNumber.toLocaleString()}</dd></div>
          <div><dt>源块</dt><dd>{transfer?.encoder.blockCount.toLocaleString() ?? "—"}</dd></div>
          <div><dt>QR</dt><dd>{qrVersion ? `V${qrVersion}-${ecc}` : "—"}</dd></div>
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
