import {
  AudioLines,
  ArrowRight,
  Camera,
  CheckCircle2,
  Code2,
  Download,
  FileArchive,
  GitBranch,
  Monitor,
  QrCode,
  ScanLine,
  Send,
  ShieldCheck,
  Smartphone,
  WifiOff,
  Zap,
} from "lucide-react";

const RELEASE_BASE = "https://github.com/Jensen-Yao/DataYao/releases/download/v0.3.0";

const downloads = [
  {
    icon: Monitor,
    title: "Windows XP / 7",
    detail: "原生 x86 发送端 · 约 815 KB · 解压即用",
    href: `${RELEASE_BASE}/DataYao-0.3.0-Windows-XP-Win7-x86-Portable.zip`,
    action: "下载 Legacy",
  },
  {
    icon: Monitor,
    title: "Windows 10 / 11",
    detail: "原生 x64 发送端 · 约 1.12 MB · 无 WebView2",
    href: `${RELEASE_BASE}/DataYao-0.3.0-Windows-Win10-Win11-x64-Portable.zip`,
    action: "下载 Modern",
  },
  {
    icon: Smartphone,
    title: "Android 接收端",
    detail: "GitHub 签名 APK · Android 7.0+ · 接收专用",
    href: `${RELEASE_BASE}/DataYao-Receiver-release.apk`,
    action: "下载 APK",
  },
  {
    icon: Smartphone,
    title: "HarmonyOS 接收端",
    detail: "未签名开发验证包 · Stage 工程",
    href: `${RELEASE_BASE}/DataYao-0.3.0-HarmonyOS-unsigned.zip`,
    action: "下载鸿蒙包",
  },
] as const;

interface HomeViewProps {
  onSend: () => void;
  onReceive: () => void;
}

export function HomeView({ onSend, onReceive }: HomeViewProps) {
  return (
    <div className="home-page">
      <section className="home-hero">
        <img className="home-hero-media" src="./datayao-native-sender.png" alt="DataYao Windows 原生发送端正在播放动态二维码" />
        <div className="home-hero-copy">
          <h1>DataYao</h1>
          <p className="home-hero-lead">双端离线的数据通道。</p>
          <p className="home-hero-description">
            发送端把文件变成连续二维码或声音，接收端使用摄像头或麦克风恢复数据。没有 Wi-Fi、蓝牙、服务器或账号，也不上传任何内容。
          </p>
          <div className="home-hero-actions">
            <button className="home-primary-action" type="button" onClick={onSend}>
              <Send size={18} /> 立即发送
            </button>
            <button className="home-secondary-action" type="button" onClick={onReceive}>
              <ScanLine size={18} /> 打开接收
            </button>
          </div>
          <div className="home-hero-links">
            <a href="#downloads">下载 Windows 便携版 <ArrowRight size={15} /></a>
            <a href="https://github.com/Jensen-Yao/DataYao" target="_blank" rel="noreferrer">
              查看源代码 <GitBranch size={15} />
            </a>
          </div>
        </div>
      </section>

      <section className="home-facts" aria-label="DataYao 核心信息">
        <div><strong>0</strong><span>网络依赖</span></div>
        <div><strong>64 MB</strong><span>QR 单次上限</span></div>
        <div><strong>815 KB</strong><span>Legacy 压缩包</span></div>
        <div><strong>3</strong><span>离线载波模式</span></div>
      </section>

      <section className="home-section home-how" id="how-it-works">
        <div className="home-section-heading">
          <h2>屏幕或扬声器，就是离线数据通道</h2>
          <p>同一份数据协议贯穿 Web、Windows、Android 与 HarmonyOS。设备之间不建立连接，隔离网络里也能工作。</p>
        </div>
        <div className="home-steps">
          <article>
            <span className="home-step-number">01</span>
            <FileArchive size={28} />
            <h3>选择内容</h3>
            <p>拖入文件或输入文本。文件名、MIME 类型与 SHA-256 会写入本地传输容器。</p>
          </article>
          <article>
            <span className="home-step-number">02</span>
            <QrCode size={28} />
            <h3>选择传输载波</h3>
            <p>标准 QR 优先稳定，彩色 QR 一帧承载三路数据；声音适合 64 KB 内的短数据兜底。</p>
          </article>
          <article>
            <span className="home-step-number">03</span>
            <Camera size={28} />
            <h3>摄像头或麦克风恢复</h3>
            <p>三种载波都进入同一套 LT Fountain 解码器，恢复后再次验证 CRC32 与 SHA-256。</p>
          </article>
        </div>
      </section>

      <section className="home-receiver-band">
        <div className="home-receiver-inner">
          <div className="home-receiver-copy">
            <h2>看得见每一步，失败也有具体原因</h2>
            <p>
              接收端分别统计采集、分析、载波识别、有效帧、重复帧和恢复块。相机没出画面、二维码太密、声音无有效包或协议不匹配，不再只显示一个停住的 0%。
            </p>
            <ul>
              <li><CheckCircle2 size={18} /> 原始摄像头帧直接送入双 Worker</li>
              <li><AudioLines size={18} /> 声音帧独立校验长度与 CRC32</li>
              <li><CheckCircle2 size={18} /> 忙时丢弃旧画面，避免延迟堆积</li>
              <li><CheckCircle2 size={18} /> 文本可复制，文件通过系统选择器保存</li>
            </ul>
            <button className="home-dark-action" type="button" onClick={onReceive}>
              <Camera size={18} /> 启动在线接收
            </button>
          </div>
          <figure className="home-receiver-media">
            <img src="./datayao-receiver-success.png" alt="DataYao 接收端完成文本恢复并通过 SHA-256 校验" />
            <figcaption>Web / Android / HarmonyOS 共用接收与校验核心</figcaption>
          </figure>
        </div>
      </section>

      <section className="home-section home-downloads" id="downloads">
        <div className="home-section-heading home-download-heading">
          <h2>选择适合当前设备的版本</h2>
          <p>Windows 包只有发送能力，体积更小；手机端专注接收。浏览器版本同时保留发送和接收。</p>
        </div>
        <div className="home-download-list">
          {downloads.map(({ icon: Icon, title, detail, href, action }) => (
            <article className="home-download-row" key={title}>
              <Icon size={24} aria-hidden="true" />
              <div>
                <h3>{title}</h3>
                <p>{detail}</p>
              </div>
              <a href={href}>
                <Download size={17} /> {action}
              </a>
            </article>
          ))}
          <article className="home-download-row home-download-online">
            <Code2 size={24} aria-hidden="true" />
            <div>
              <h3>Web / PWA</h3>
              <p>当前页面即可使用 · 首次加载后支持离线运行</p>
            </div>
            <button type="button" onClick={onSend}>
              <ArrowRight size={17} /> 在线使用
            </button>
          </article>
        </div>
        <p className="home-download-note">
          Windows ZIP 已由 GitHub Actions 构建并生成 provenance。传输协议不加密；签名和校验用于确认安装包来源与数据完整性。
        </p>
      </section>

      <section className="home-platform-band">
        <div className="home-platform-copy">
          <h2>从 Windows XP 到现代手机</h2>
          <p>发送端可以来自断网老电脑，接收端只需一部有摄像头和麦克风的手机。两端不要求处于同一网络，也不交换设备身份。</p>
          <div className="home-platform-points">
            <span><WifiOff size={18} /> 全程无网络请求</span>
            <span><ShieldCheck size={18} /> CRC32 + 容器 CRC + SHA-256</span>
            <span><Zap size={18} /> 800–2300 B / 10–30 fps 可调</span>
            <span><AudioLines size={18} /> 声音模式适合 64 KB 内短数据</span>
          </div>
        </div>
        <img src="./datayao-mobile-sender.png" alt="DataYao 移动端发送界面" />
      </section>

      <section className="home-section home-engineering">
        <div className="home-section-heading">
          <h2>开放协议，明确边界</h2>
          <p>DataYao 不把完整性校验包装成加密，也不把浏览器静态扫码速度当作动态数据传输速度。</p>
        </div>
        <div className="home-engineering-grid">
          <div>
            <h3>稳定性</h3>
            <p>LT Fountain 允许帧乱序、丢失和重复；接收端收到足够独立方程即可恢复。</p>
          </div>
          <div>
            <h3>可诊断</h3>
            <p>采集、分析、识别和恢复分别计数，连续失败会报告相机、解码器或构图问题。</p>
          </div>
          <div>
            <h3>隐私边界</h3>
            <p>内容不会上传，但屏幕上的二维码是明文数据载体，不适合传输需要保密的资料。</p>
          </div>
          <div>
            <h3>可复现</h3>
            <p>协议、测试向量、构建脚本和各平台外壳均在公开仓库中，可独立审查与构建。</p>
          </div>
        </div>
      </section>

      <section className="home-final-cta">
        <h2>无需配网，现在就传。</h2>
        <div>
          <button type="button" onClick={onSend}><Send size={18} /> 开始发送</button>
          <a href="https://github.com/Jensen-Yao/DataYao" target="_blank" rel="noreferrer"><GitBranch size={18} /> GitHub</a>
        </div>
      </section>
    </div>
  );
}
