import { useEffect, useState } from "react";
import { GitBranch, ScanLine, Send, WifiOff } from "lucide-react";
import { SenderView } from "./components/SenderView";
import { ReceiverView } from "./components/ReceiverView";

export function App() {
  const receiverOnly = import.meta.env.VITE_RECEIVER_ONLY === "1";
  const [mode, setMode] = useState<"send" | "receive">(receiverOnly ? "receive" : "send");
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="./" aria-label="DataYao 首页">
          <img src="./datayao-mark.svg" alt="" />
          <span>DataYao</span>
        </a>
        <nav className="mode-tabs" aria-label="传输模式">
          {!receiverOnly && (
            <button type="button" className={mode === "send" ? "active" : ""} onClick={() => setMode("send")}>
              <Send size={17} /> 发送
            </button>
          )}
          <button type="button" className={mode === "receive" ? "active" : ""} onClick={() => setMode("receive")}>
            <ScanLine size={17} /> 接收
          </button>
        </nav>
        <div className="header-actions">
          <span className="network-state"><WifiOff size={15} />{online ? "可离线使用" : "离线运行中"}</span>
          <a className="icon-button" href="https://github.com/Jensen-Yao/DataYao" target="_blank" rel="noreferrer" title="GitHub 仓库">
            <GitBranch size={19} />
          </a>
        </div>
      </header>

      <main>{mode === "send" ? <SenderView /> : <ReceiverView />}</main>

      <footer>
        <span>DataYao v0.2.0</span>
        <span>标准 QR · LT Fountain · SHA-256</span>
      </footer>
    </div>
  );
}
