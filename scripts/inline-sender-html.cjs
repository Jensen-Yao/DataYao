const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "artifacts", "html", ".sender-html-build");
const outputDir = path.join(root, "artifacts", "html");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const indexPath = path.join(buildDir, "sender-html.html");
const outputPath = path.join(outputDir, `DataYao-Sender-${packageJson.version}.html`);

let html = fs.readFileSync(indexPath, "utf8");
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_match, href) => {
  const css = fs.readFileSync(path.resolve(buildDir, href), "utf8").replace(/<\/style/gi, "<\\/style");
  return `<style>${css}</style>`;
});
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_match, src) => {
  const script = fs.readFileSync(path.resolve(buildDir, src), "utf8").replace(/<\/script/gi, "<\\/script");
  return `<script type="module">${script}</script>`;
});
fs.writeFileSync(outputPath, html, "utf8");
console.log(`Created ${path.relative(root, outputPath)}`);
