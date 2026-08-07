/**
 * Generate platform icons from public/logo.jpg.
 *
 * Produces:
 *   - build/icon.ico               (Windows multi-size ICO with PNG entries)
 *   - Android launcher PNGs         (ic_launcher, ic_launcher_round, ic_launcher_foreground)
 *   - HarmonyOS app_icon.png        (216x216)
 *
 * Requires Windows PowerShell with System.Drawing (available on windows-latest CI).
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const sourceLogo = path.join(root, "public", "logo.jpg");
const buildDir = path.join(root, "build");

// ---------- helpers ----------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resizePng(srcJpg, destPng, size) {
  // Use PowerShell System.Drawing to resize and convert to PNG.
  const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${srcJpg.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap(${size}, ${size})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.DrawImage($src, 0, 0, ${size}, ${size})
$bmp.Save('${destPng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`PowerShell resize failed (${result.status}): ${result.stderr?.toString()}`);
  }
}

function readPng(filePath) {
  return fs.readFileSync(filePath);
}

function createIco(pngEntries, icoPath) {
  // ICO with PNG entries (supported on Windows Vista+).
  const count = pngEntries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + dirEntrySize * count;
  const entries = [];
  for (const { size, data } of pngEntries) {
    entries.push({
      width: size >= 256 ? 0 : size,
      height: size >= 256 ? 0 : size,
      size: data.length,
      offset,
      data,
    });
    offset += data.length;
  }
  const buf = Buffer.alloc(headerSize + dirEntrySize * count);
  buf.writeUInt16LE(0, 0); // reserved
  buf.writeUInt16LE(1, 2); // type = ICO
  buf.writeUInt16LE(count, 4);
  let p = headerSize;
  for (const e of entries) {
    buf.writeUInt8(e.width, p);
    buf.writeUInt8(e.height, p + 1);
    buf.writeUInt8(0, p + 2); // color count
    buf.writeUInt8(0, p + 3); // reserved
    buf.writeUInt16LE(1, p + 4); // color planes
    buf.writeUInt16LE(32, p + 6); // bits per pixel
    buf.writeUInt32LE(e.size, p + 8);
    buf.writeUInt32LE(e.offset, p + 12);
    p += dirEntrySize;
  }
  const total = Buffer.concat([buf, ...entries.map((e) => e.data)]);
  fs.writeFileSync(icoPath, total);
}

// ---------- generate ----------

function main() {
  if (!fs.existsSync(sourceLogo)) {
    throw new Error(`Source logo not found: ${sourceLogo}`);
  }
  ensureDir(buildDir);
  const tmpDir = path.join(buildDir, "tmp");
  ensureDir(tmpDir);

  const icoSizes = [16, 32, 48, 64, 128, 256];
  console.log("Generating Windows ICO sizes:", icoSizes.join(", "));
  const icoPngs = [];
  for (const s of icoSizes) {
    const pngPath = path.join(tmpDir, `icon-${s}.png`);
    resizePng(sourceLogo, pngPath, s);
    icoPngs.push({ size: s, data: readPng(pngPath) });
  }
  const icoPath = path.join(buildDir, "icon.ico");
  createIco(icoPngs, icoPath);
  console.log("Created", icoPath);

  // Android launcher icons
  const androidRes = path.join(root, "android", "app", "src", "main", "res");
  const densities = [
    { dir: "mipmap-mdpi", size: 48 },
    { dir: "mipmap-hdpi", size: 72 },
    { dir: "mipmap-xhdpi", size: 96 },
    { dir: "mipmap-xxhdpi", size: 144 },
    { dir: "mipmap-xxxhdpi", size: 192 },
  ];
  const fgDensities = [
    { dir: "mipmap-mdpi", size: 108 },
    { dir: "mipmap-hdpi", size: 162 },
    { dir: "mipmap-xhdpi", size: 216 },
    { dir: "mipmap-xxhdpi", size: 324 },
    { dir: "mipmap-xxxhdpi", size: 432 },
  ];

  console.log("Generating Android ic_launcher / ic_launcher_round PNGs");
  for (const { dir, size } of densities) {
    const destDir = path.join(androidRes, dir);
    ensureDir(destDir);
    const pngPath = path.join(destDir, "ic_launcher.png");
    resizePng(sourceLogo, pngPath, size);
    fs.copyFileSync(pngPath, path.join(destDir, "ic_launcher_round.png"));
  }

  console.log("Generating Android ic_launcher_foreground PNGs");
  for (const { dir, size } of fgDensities) {
    const destDir = path.join(androidRes, dir);
    ensureDir(destDir);
    const pngPath = path.join(destDir, "ic_launcher_foreground.png");
    resizePng(sourceLogo, pngPath, size);
  }

  // HarmonyOS app icon (216x216 PNG)
  const harmonyMedia = path.join(root, "harmony", "entry", "src", "main", "resources", "base", "media");
  ensureDir(harmonyMedia);
  const harmonyIcon = path.join(harmonyMedia, "app_icon.png");
  resizePng(sourceLogo, harmonyIcon, 216);
  console.log("Created", harmonyIcon);

  // Remove old SVG to avoid ambiguity
  const oldSvg = path.join(harmonyMedia, "app_icon.svg");
  if (fs.existsSync(oldSvg)) {
    fs.rmSync(oldSvg, { force: true });
    console.log("Removed old", oldSvg);
  }

  // Clean up temp
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("Done.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
