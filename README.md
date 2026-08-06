# DataYao

DataYao 是一个双端离线的动态二维码传输工具：发送端把文件或文本编码为连续 QR 帧，接收端只使用摄像头扫描并在本地恢复。传输链路不需要 Wi-Fi、蓝牙、移动网络或服务器，也不包含加密层，适合临时、低依赖的近距离数据搬运。

**在线体验：** [jensen-yao.github.io/DataYao](https://jensen-yao.github.io/DataYao/)

**最新发布：** [Windows Portable ZIP](https://github.com/Jensen-Yao/DataYao/releases/download/v0.2.0/DataYao-0.2.0-Windows-x64-Portable.zip) · [Android Receiver APK](https://github.com/Jensen-Yao/DataYao/releases/download/v0.2.0/DataYao-Receiver-0.2.0-release.apk)

## 特性

- **双端离线**：页面首次加载后由 Service Worker 缓存；光学传输阶段没有网络请求。
- **抗丢帧**：LT fountain code 允许帧乱序、丢失和重复，接收端收到足够独立方程即可恢复。
- **完整性校验**：每个 QR 帧带 CRC32，完整容器恢复后再做 SHA-256 校验。
- **文件与文本**：保留文件名和 MIME 类型；可选 gzip 压缩，文本支持直接复制。
- **可调参数**：每帧字节数、播放帧率和 QR 纠错等级可按屏幕、距离和相机能力调节。
- **纯前端**：React + TypeScript + Vite，无后端、无账号、无遥测。

## 使用方法

1. 在发送设备打开页面，选择“文件”或“文本”，选择内容后点击“开始发送”。
2. 调整屏幕亮度，保持二维码完整显示；另一台设备打开同一页面并切换到“接收”。
3. 接收端允许摄像头权限，优先使用后置摄像头，对准发送端二维码区域。
4. 看到“接收完成”后，文本可复制，文件可保存。

## 便携版与 Android 接收端

### Windows 双端便携版

便携版包含发送和接收两个模式，解压后直接运行 `DataYao.exe`，不写入安装目录，也不要求 Node.js。它把同一套离线 Web 核心放进 Electron Runtime，Windows 摄像头权限由系统首次启动时请求。

本地生成：

```bash
npm run package:portable
```

产物位于 `artifacts/desktop/`：`DataYao-<version>-Windows-x64-Portable.zip`。该包体积较大，因为包含 Chromium 运行时；这是为了保证解压即用，不依赖用户预装浏览器。

### Android 接收端 APK

Android 工程使用 Capacitor，构建时设置 `VITE_RECEIVER_ONLY=1`，启动后直接进入接收页并隐藏发送入口，只申请摄像头权限。仓库的 `.github/workflows/android.yml` 会在 GitHub Actions 中安装 Android SDK、构建 release APK、使用 GitHub Actions Secrets 中的 JKS 发布密钥签名，并生成 GitHub artifact provenance。

需要配置的仓库 Secrets：

```text
ANDROID_KEYSTORE_BASE64
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
```

构建工作流支持手动触发或推送 `v*` 标签。下载 APK 后可以用 GitHub CLI 验证 provenance：

```bash
gh attestation verify DataYao-Receiver-release.apk -R Jensen-Yao/DataYao
```

APK 的签名用于确认发布者和升级来源，不会对光学传输内容加密；传输协议仍按设计保持明文并使用 SHA-256 做完整性校验。

### 摄像头与 HTTPS

浏览器通常只会在安全上下文中开放摄像头权限。GitHub Pages 默认提供 HTTPS；本地开发请使用 `localhost`，或通过 HTTPS 反向代理访问。发送端可以完全离线运行，接收端第一次打开页面仍需要先把应用资源缓存到本机。

## 稳定性调优

默认参数为 **1600 bytes/frame、24 fps、ECC-L**，通常能在速度和识别稳定性之间取得平衡。

- 识别困难、距离较远或屏幕较小：降低每帧字节数到 800/1200，帧率降到 10/15，纠错改为 M。
- 光线充足、设备性能较好：可尝试 2000/2300 bytes 和 24/30 fps。
- 保持二维码四周留白，避免浏览器缩放、系统护眼滤镜和屏幕反光。
- 接收页会显示有效帧、重复帧、已恢复块和解码 FPS，便于判断参数是否合适。

## 协议概要

每个 QR 帧由固定头和一个 fountain block 组成。头部包含 magic/version、会话 ID、序号、块数、块大小、总长度、CRC32 和 flags。发送端根据会话 ID 与序号确定本帧参与异或的源块；接收端使用相同规则解方程，因此不依赖帧顺序，也不需要建立双向连接。

文件容器保存文件名、MIME、原始长度、压缩标记和 SHA-256。当前单次传输限制为 **64 MB**；文本输入限制为 **4 MiB**。这是完整性校验，不是加密：传输内容可被看到，也不会隐藏元数据。

## 本地开发

```bash
npm ci
npm run dev
```

常用校验命令：

```bash
npm run typecheck
npm test
npm run build
npm run preview
npm run package:portable
npm run build:android
```

## 目录结构

```text
src/components/  发送端和接收端 UI
src/core/        QR、协议、CRC/SHA-256、LT fountain code
desktop/         Electron 主进程和 Windows 便携包脚本
android/         Capacitor Android 接收端工程
public/          PWA 静态资源和品牌图标
.github/workflows Pages、Windows Portable、Android APK 工作流
```

## 限制与隐私

- 这是单向光学通道；发送端不会收到接收端 ACK，丢帧通过 fountain 冗余抵消。
- 传输速度受二维码尺寸、屏幕刷新率、相机帧率和环境光影响。
- 页面不提供加密或身份认证，请勿传输需要保密的内容。
- 应用不上传文件、不调用后端 API；浏览器摄像头画面只在本地处理。

## 许可

[MIT License](LICENSE)

