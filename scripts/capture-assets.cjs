// Regenerates the marketing screenshots in public/ from the current build:
//   datayao-receiver-success.png  phone viewport, fake camera, completed text transfer
//   datayao-mobile-sender.png     phone viewport, sender playing a dynamic QR
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("@playwright/test");
const { PNG } = require("pngjs");

const root = path.resolve(__dirname, "..");
const webRoot = path.join(root, "dist");
const artifacts = path.join(root, "artifacts", "tests");
const receiverVideo = path.join(artifacts, "datayao-hero-loopback.y4m");
const transferText = "DataYao v0.4.0 offline transfer";
const chromePath = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => fs.existsSync(candidate));

const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

function createServer() {
  return http.createServer((request, response) => {
    const urlPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    const file = path.resolve(webRoot, relative);
    if (!file.startsWith(`${webRoot}${path.sep}`) || !fs.existsSync(file)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": mimeTypes[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
}

function writeY4m(qrPng, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const qr = PNG.sync.read(qrPng);
  const width = 1280;
  const height = 960;
  const xStart = Math.floor((width - qr.width) / 2);
  const yStart = Math.floor((height - qr.height) / 2);
  const y = Buffer.alloc(width * height, 235);
  const u = Buffer.alloc((width * height) / 4, 128);
  const v = Buffer.alloc((width * height) / 4, 128);
  const toY = (red, green, blue) =>
    Math.max(16, Math.min(235, Math.round(16 + (65.738 * red + 129.057 * green + 25.064 * blue) / 256)));
  for (let sourceY = 0; sourceY < qr.height; sourceY++) {
    for (let sourceX = 0; sourceX < qr.width; sourceX++) {
      const offset = (sourceY * qr.width + sourceX) * 4;
      y[(yStart + sourceY) * width + xStart + sourceX] = toY(qr.data[offset], qr.data[offset + 1], qr.data[offset + 2]);
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`);
  const marker = Buffer.from("FRAME\n");
  const frames = [header];
  for (let index = 0; index < 4; index++) frames.push(marker, y, u, v);
  fs.writeFileSync(outputPath, Buffer.concat(frames));
}

async function senderCanvasPng(baseUrl) {
  const launchOptions = { headless: true };
  if (chromePath) launchOptions.executablePath = chromePath;
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "文本" }).click();
    await page.locator("textarea").fill(transferText);
    await page.getByLabel("每帧字节").selectOption("800");
    await page.getByLabel("播放帧率").selectOption("10");
    await page.getByRole("button", { name: "开始发送" }).click();
    await page.locator("canvas").waitFor();
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width >= 480;
    });
    await page.waitForTimeout(600);
    return await page.locator("canvas").screenshot();
  } finally {
    await browser.close();
  }
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  try {
    writeY4m(await senderCanvasPng(baseUrl), receiverVideo);

    const launchOptions = {
      headless: true,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-video-capture=${receiverVideo.replaceAll("\\", "/")}`,
      ],
    };
    if (chromePath) launchOptions.executablePath = chromePath;
    const browser = await chromium.launch(launchOptions);

    // Completed receiver on a phone viewport.
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        permissions: ["camera"],
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "接收", exact: true }).click();
      await page.getByRole("button", { name: "启动摄像头" }).click();
      await page.getByRole("heading", { name: "文本接收完成" }).waitFor();
      await page.addStyleTag({ content: ".camera-select { display: none !important; }" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(root, "public", "datayao-receiver-success.png") });
      await context.close();
    } finally {
      await browser.close();
    }

    // Mobile sender playing a dynamic QR.
    {
      const launchOptions2 = { headless: true };
      if (chromePath) launchOptions2.executablePath = chromePath;
      const browser2 = await chromium.launch(launchOptions2);
      const context = await browser2.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.getByRole("button", { name: "文本" }).click();
      await page.locator("textarea").fill(transferText);
      await page.getByRole("button", { name: "开始发送" }).click();
      await page.waitForFunction(() => {
        // An untouched canvas is 300px wide; any painted DataYao canvas
        // differs from the default regardless of viewport size.
        const canvas = document.querySelector("canvas");
        return canvas instanceof HTMLCanvasElement && canvas.width !== 300;
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        document.querySelector(".receiver-stage, .visual-stage")?.scrollIntoView({ block: "start" });
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(root, "public", "datayao-mobile-sender.png") });
      await browser2.close();
    }
    console.log("assets captured");
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
