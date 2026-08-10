import { useEffect, useState } from "react";
import { GitBranch, House, ScanLine, Send, WifiOff } from "lucide-react";
import { HomeView } from "./components/HomeView";
import { ReceiverView } from "./components/ReceiverView";
import { SenderView } from "./components/SenderView";

type AppMode = "home" | "send" | "receive";

function initialMode(receiverOnly: boolean): AppMode {
  if (receiverOnly) return "receive";
  const hash = window.location.hash.slice(1);
  if (hash === "home" || hash === "send" || hash === "receive") return hash;
  return window.location.protocol === "file:" ? "send" : "home";
}

export function App() {
  const receiverOnly = import.meta.env.VITE_RECEIVER_ONLY === "1";
  const [mode, setMode] = useState<AppMode>(() => initialMode(receiverOnly));
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

  useEffect(() => {
    if (receiverOnly) return;

    const syncModeFromLocation = () => setMode(initialMode(false));
    window.addEventListener("hashchange", syncModeFromLocation);
    window.addEventListener("popstate", syncModeFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncModeFromLocation);
      window.removeEventListener("popstate", syncModeFromLocation);
    };
  }, [receiverOnly]);

  function selectMode(nextMode: AppMode) {
    setMode(nextMode);
    if (!receiverOnly && window.location.hash !== `#${nextMode}`) {
      window.history.pushState(null, "", `#${nextMode}`);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className={`app-shell${mode === "home" ? " is-home" : ""}`}>
      <header className="site-header">
        <button className="brand" type="button" onClick={() => selectMode(receiverOnly ? "receive" : "home")} aria-label="DataYao 首页">
          <img src="./logo.jpg" alt="" />
          <span>DataYao</span>
        </button>
        <nav className="mode-tabs" aria-label="页面导航">
          {!receiverOnly && (
            <button type="button" className={mode === "home" ? "active" : ""} onClick={() => selectMode("home")}>
              <House size={17} /> 首页
            </button>
          )}
          {!receiverOnly && (
            <button type="button" className={mode === "send" ? "active" : ""} onClick={() => selectMode("send")}>
              <Send size={17} /> 发送
            </button>
          )}
          <button type="button" className={mode === "receive" ? "active" : ""} onClick={() => selectMode("receive")}>
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

      <main className={mode === "home" ? "home-main" : "tool-main"}>
        {mode === "home" && <HomeView onSend={() => selectMode("send")} onReceive={() => selectMode("receive")} />}
        {mode === "send" && <SenderView />}
        {mode === "receive" && <ReceiverView />}
      </main>

      <footer>
        <span>DataYao v0.2.5</span>
        <span>标准 QR · LT Fountain · SHA-256</span>
      </footer>
    </div>
  );
}
