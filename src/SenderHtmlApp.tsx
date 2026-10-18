import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { File as FileIcon, FileText, Maximize2, Play, Send, Square, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { LTEncoder } from "./core/fountain";
import { MAX_FILE_BYTES, makeFrameHeader, packFrame, packTransfer, type TransferPayload } from "./core/protocol";
import { renderQr, type QrEcc } from "./core/qr";
import "./sender-html.css";

const BLOCK_OPTIONS = [800, 1200, 1600, 2000, 2300] as const;
const FPS_OPTIONS = [10, 15, 20, 24, 30] as const;

interface LiveTransfer {
  payload: TransferPayload;
  encoder: LTEncoder;
  header: ReturnType<typeof makeFrameHeader>;
}

export function SenderHtmlApp() {
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
  const stageRef = useRef<HTMLElement>(null);
  const dragDepthRef = useRef(0);

  const estimatedRate = useMemo(
    () => `${Math.round((blockSize * fps) / 1.2 / 1024)} KB/s`,
    [blockSize, fps],
  );

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
          const rendered = renderQr(canvasRef.current, packFrame({ ...transfer.header, sequence }, block), ecc);
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
      const sessionId = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
      const encoder = new LTEncoder(payload.container, blockSize, sessionId);
      setTransfer({ payload, encoder, header: makeFrameHeader(payload.container, blockSize, sessionId, isText ? 1 : 0) });
      setFrameNumber(0);
      setQrVersion(null);
      setRunning(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function chooseFile(candidate: File | undefined) {
    if (!candidate) return;
    if (candidate.size > MAX_FILE_BYTES) {
      setError("文件不能超过 256 MB");
      return;
    }
    setError("");
    setFile(candidate);
  }

  function handleDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (running) return;
    dragDepthRef.current++;
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
    if (!running) chooseFile(event.dataTransfer.files?.[0]);
  }

  async function enterFullscreen() {
    await stageRef.current?.requestFullscreen?.();
  }

  const selectedLabel = sourceMode === "file"
    ? file?.name
    : text.trim() ? `${new TextEncoder().encode(text).length} 字节文本` : "";

  return (
    <div className="sender-html-app">
      <header className="sender-html-header">
        <div className="sender-html-brand"><span>DY</span><strong>DataYao</strong></div>
        <div>离线动态二维码发送端</div>
      </header>
      <main className="sender-html-main">
        <section className="sender-html-controls" aria-label="发送设置">
          <div className="sender-html-heading">
            <p>发送</p>
            <h1>在屏幕上播放二维码</h1>
            <span>无网运行。接收端使用 DataYao 扫描恢复文件或文本。</span>
          </div>
          <div className="sender-html-switch" role="tablist" aria-label="内容类型">
            <button className={sourceMode === "file" ? "active" : ""} onClick={() => setSourceMode("file")} type="button" disabled={running}>
              <FileIcon size={17} /> 文件
            </button>
            <button className={sourceMode === "text" ? "active" : ""} onClick={() => setSourceMode("text")} type="button" disabled={running}>
              <FileText size={17} /> 文本
            </button>
          </div>
          {sourceMode === "file" ? (
            <label
              className={`sender-html-drop${dragActive ? " is-dragging" : ""}${running ? " is-disabled" : ""}`}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              aria-disabled={running}
            >
              <Upload size={26} />
              <strong>{file ? file.name : "选择或拖入文件"}</strong>
              <small>{file ? formatBytes(file.size) : "最大 256 MB"}</small>
              <input type="file" disabled={running} onChange={(event) => chooseFile(event.target.files?.[0])} />
            </label>
          ) : (
            <label className="sender-html-text">
              <span>文本内容</span>
              <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4 * 1024 * 1024} disabled={running} />
            </label>
          )}
          <div className="sender-html-settings">
            <label><span>每帧字节</span><select value={blockSize} onChange={(event) => setBlockSize(Number(event.target.value))} disabled={running}>{BLOCK_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label><span>播放帧率</span><select value={fps} onChange={(event) => setFps(Number(event.target.value))} disabled={running}>{FPS_OPTIONS.map((value) => <option key={value} value={value}>{value} fps</option>)}</select></label>
            <label><span>二维码纠错</span><select value={ecc} onChange={(event) => setEcc(event.target.value as QrEcc)} disabled={running}><option value="L">L · 快速</option><option value="M">M · 稳定</option></select></label>
            <div className="sender-html-rate"><span>预计有效速率</span><strong>{estimatedRate}</strong></div>
          </div>
          {error && <div className="sender-html-error" role="alert">{error}</div>}
          {!running ? <button className="sender-html-primary" type="button" onClick={startTransfer} disabled={!selectedLabel}><Play size={18} fill="currentColor" />开始发送</button> : <button className="sender-html-stop" type="button" onClick={() => setRunning(false)}><Square size={17} fill="currentColor" />停止</button>}
        </section>

        <section className="sender-html-stage" ref={stageRef} aria-label="动态二维码">
          <div className="sender-html-stagebar"><span><i className={running ? "live" : ""} />{running ? "正在发送" : "等待开始"}</span><button type="button" onClick={enterFullscreen} title="全屏显示二维码" disabled={!running}><Maximize2 size={19} /></button></div>
          <div className="sender-html-qr-shell">
            <canvas ref={canvasRef} aria-label="DataYao 动态二维码" style={{ width: `${qrScale}%` }} />
            {!running && <div className="sender-html-empty"><Send size={42} /><strong>DataYao</strong><span>光学传输待机</span></div>}
          </div>
          <div className="sender-html-size"><ZoomOut size={16} /><label htmlFor="sender-html-qr-scale">二维码大小</label><input id="sender-html-qr-scale" type="range" min="40" max="100" step="5" value={qrScale} onChange={(event) => setQrScale(Number(event.target.value))} /><output htmlFor="sender-html-qr-scale">{qrScale}%</output><ZoomIn size={16} /></div>
          <dl className="sender-html-metrics">
            <div><dt>序列</dt><dd>{frameNumber.toLocaleString()}</dd></div>
            <div><dt>源块</dt><dd>{transfer?.encoder.blockCount.toLocaleString() ?? "-"}</dd></div>
            <div><dt>二维码</dt><dd>{qrVersion ? `V${qrVersion}-${ecc}` : "-"}</dd></div>
            <div><dt>载荷</dt><dd>{transfer ? formatBytes(transfer.payload.container.length) : "-"}</dd></div>
          </dl>
        </section>
      </main>
      <footer className="sender-html-footer">DataYao v0.4.0 · 仅动态二维码 · 无需网络</footer>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
