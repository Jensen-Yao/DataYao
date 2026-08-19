const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const root = path.resolve(__dirname, "..");
const webRoot = path.join(root, "harmony", "entry", "src", "main", "resources", "rawfile", "datayao");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function createServer() {
  return http.createServer((request, response) => {
    const urlPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    const file = path.resolve(webRoot, relative);
    if (!file.startsWith(`${webRoot}${path.sep}`) && file !== path.join(webRoot, "index.html")) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": mimeTypes[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
}

async function main() {
  if (!fs.existsSync(path.join(webRoot, "index.html"))) {
    throw new Error("Harmony rawfile assets are missing. Run npm run build:harmony first.");
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start the smoke-test server.");

  // Prefer Playwright's pinned browser for deterministic smoke tests. An external
  // browser is opt-in because system Chrome builds can exit while fake media is active.
  const chromePath = process.env.CHROME_PATH;
  const launchOptions = {
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  };
  if (chromePath && fs.existsSync(chromePath)) launchOptions.executablePath = chromePath;
  const browser = await chromium.launch(launchOptions);
  try {
    console.log(`Smoke server: http://127.0.0.1:${address.port}/`);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ["camera"],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
      window.DataYaoHarmony = {
        requestCameraPermission() {
          window.dispatchEvent(new CustomEvent("datayao-harmony-camera-permission", {
            detail: { granted: true, message: "" },
          }));
        },
        copyText() {},
        saveFileStart() {},
        saveFileChunk() {},
        saveFileFinish() {},
      };
    });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
    await page.locator(".mode-tabs").waitFor();
    console.log("Receiver UI loaded");

    const tabs = (await page.locator(".mode-tabs").innerText()).trim();
    if (tabs.includes("发送") || !tabs.includes("接收")) {
      throw new Error(`Receiver-only mode is incorrect: ${tabs}`);
    }
    await page.getByRole("button", { name: "启动摄像头" }).click();
    await page.getByText("正在扫描", { exact: true }).waitFor({ timeout: 15_000 });
    console.log("Fake camera entered scan mode");
    const videoReady = await page.locator("video").evaluate((video) => Boolean(video.srcObject));
    if (!videoReady) throw new Error("The receiver entered scan mode without a camera stream.");
    const stage = await page.locator(".receiver-stage").boundingBox();
    const controls = await page.locator(".control-rail").boundingBox();
    const camera = await page.locator(".camera-shell").boundingBox();
    if (!stage || !controls || stage.y >= controls.y) {
      throw new Error(`The scanning stage is not above the controls: stage=${JSON.stringify(stage)}, controls=${JSON.stringify(controls)}`);
    }
    if (!camera || Math.abs(camera.width - camera.height) > 2) {
      throw new Error(`The camera shell is not square: ${JSON.stringify(camera)}`);
    }
    await page.waitForTimeout(9_000);
    const diagnostic = await page.locator('[role="alert"]').innerText();
    if (!diagnostic.includes("未识别到二维码")) {
      throw new Error(`The receiver did not report a specific no-QR diagnostic: ${diagnostic}`);
    }

    const screenshot = path.join(root, "artifacts", "harmony", "DataYao-HarmonyOS-receiver-smoke.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`Harmony receiver smoke test passed: ${screenshot}`);
  } finally {
    await browser.close();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
