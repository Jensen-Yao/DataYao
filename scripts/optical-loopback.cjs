const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, _electron: electron } = require("@playwright/test");
const { PNG } = require("pngjs");

const root = path.resolve(__dirname, "..");
const webRoot = path.join(root, "dist");
const artifacts = path.join(root, "artifacts", "tests");
const videoPath = path.join(artifacts, "datayao-optical-loopback.y4m");
const expectedText = "DataYao optical loopback: ZXing WASM camera decode";
const chromePath = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => fs.existsSync(candidate));

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

function createServer() {
  return http.createServer((request, response) => {
    const urlPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    const file = path.resolve(webRoot, relative);
    if ((!file.startsWith(`${webRoot}${path.sep}`) && file !== path.join(webRoot, "index.html")) || !fs.existsSync(file)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": mimeTypes[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
}

async function createCameraFrame(baseUrl) {
  const launchOptions = { headless: true };
  if (chromePath) launchOptions.executablePath = chromePath;
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "文本" }).click();
    await page.locator("textarea").fill(expectedText);
    await page.getByLabel("每帧字节").selectOption("800");
    await page.getByLabel("播放帧率").selectOption("10");
    await page.getByRole("button", { name: "开始发送" }).click();
    await page.locator("canvas[aria-label='DataYao 动态二维码']").waitFor();
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas[aria-label='DataYao 动态二维码']");
      return canvas instanceof HTMLCanvasElement && canvas.width > 0;
    });

    return await page.locator("canvas[aria-label='DataYao 动态二维码']").screenshot();
  } finally {
    await browser.close();
  }
}

function writeY4m(qrPng) {
  fs.mkdirSync(artifacts, { recursive: true });
  const qr = PNG.sync.read(qrPng);
  const width = 1280;
  const height = 960;
  const xStart = Math.floor((width - qr.width) / 2);
  const yStart = Math.floor((height - qr.height) / 2);
  const y = Buffer.alloc(width * height, 235);
  const chroma = Buffer.alloc((width * height) / 4, 128);
  for (let sourceY = 0; sourceY < qr.height; sourceY++) {
    for (let sourceX = 0; sourceX < qr.width; sourceX++) {
      const sourceOffset = (sourceY * qr.width + sourceX) * 4;
      const luma = (77 * qr.data[sourceOffset] + 150 * qr.data[sourceOffset + 1] + 29 * qr.data[sourceOffset + 2]) >> 8;
      y[(yStart + sourceY) * width + xStart + sourceX] = 16 + Math.round((219 * luma) / 255);
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`);
  const marker = Buffer.from("FRAME\n");
  const frames = [header];
  for (let index = 0; index < 4; index++) frames.push(marker, y, chroma, chroma);
  fs.writeFileSync(videoPath, Buffer.concat(frames));
}

async function receiveCameraFrame(baseUrl) {
  const fakeVideo = videoPath.replaceAll("\\", "/");
  const launchOptions = {
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${fakeVideo}`,
    ],
  };
  if (chromePath) launchOptions.executablePath = chromePath;
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ["camera"],
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "接收" }).click();
    await page.getByRole("button", { name: "启动摄像头" }).click();
    await page.getByRole("heading", { name: "文本接收完成" }).waitFor();
    const received = await page.locator(".result-panel pre").innerText();
    if (received !== expectedText) throw new Error(`Unexpected loopback payload: ${JSON.stringify(received)}`);
    await page.screenshot({ path: path.join(artifacts, "datayao-optical-loopback.png"), fullPage: true });
    console.log(`Optical loopback passed: ${received}`);
  } finally {
    await browser.close();
  }
}

async function receiveElectronCameraFrame() {
  if (process.platform !== "win32" || !fs.existsSync(path.join(root, "node_modules", "electron", "dist", "electron.exe"))) return;
  const fakeVideo = videoPath.replaceAll("\\", "/");
  const electronApp = await electron.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${fakeVideo}`,
      root,
    ],
    env: { ...process.env, DATAYAO_TEST: "1" },
  });
  try {
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(30_000);
    await page.getByRole("button", { name: "接收" }).click();
    await page.getByRole("button", { name: "启动摄像头" }).click();
    await page.getByRole("heading", { name: "文本接收完成" }).waitFor();
    const received = await page.locator(".result-panel pre").innerText();
    if (received !== expectedText) throw new Error(`Unexpected Electron loopback payload: ${JSON.stringify(received)}`);
    console.log("Electron file:// optical loopback passed");
  } finally {
    await electronApp.close();
  }
}

async function main() {
  if (!fs.existsSync(path.join(webRoot, "index.html"))) throw new Error("Run npm run build before the optical loopback test.");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start the optical loopback server.");
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  try {
    writeY4m(await createCameraFrame(baseUrl));
    await receiveCameraFrame(baseUrl);
    await receiveElectronCameraFrame();
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
