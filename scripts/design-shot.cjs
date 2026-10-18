const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const webRoot = path.resolve("F:/DataYao/dist");
const outDir = "F:/DataYao/artifacts/tests";
const mimeTypes = { ".css": "text/css", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".jpg": "image/jpeg", ".png": "image/png" };

const server = http.createServer((request, response) => {
  const urlPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
  const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const file = path.resolve(webRoot, relative);
  if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": mimeTypes[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
});

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, "design-home.png"), fullPage: false });
  await page.screenshot({ path: path.join(outDir, "design-home-full.png"), fullPage: true });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "design-send.png") });
  await page.getByRole("button", { name: "接收", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, "design-receive.png") });
  await browser.close();
  server.close();
  console.log("shots done");
})().catch((e) => { console.error(e); process.exit(1); });
