const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const outputRoot = path.join(root, "artifacts", "desktop");
const portableDir = path.join(outputRoot, "DataYao");
const appDir = path.join(portableDir, "resources", "app");
const electronDir = path.join(root, "node_modules", "electron", "dist");
const zipPath = path.join(outputRoot, `DataYao-${packageJson.version}-Windows-x64-Portable.zip`);

async function ensureElectronRuntime() {
  try {
    await fs.access(path.join(electronDir, "electron.exe"));
    return;
  } catch {
    const installer = path.join(root, "node_modules", "electron", "install.js");
    const result = spawnSync(process.execPath, [installer], {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/" },
    });
    if (result.status !== 0) throw new Error(`Electron runtime download failed with exit code ${result.status}`);
  }
}

async function main() {
  await ensureElectronRuntime();
  await fs.access(path.join(electronDir, "electron.exe"));
  await fs.access(path.join(root, "dist", "index.html"));
  await fs.rm(portableDir, { recursive: true, force: true });
  await fs.rm(zipPath, { force: true });
  await fs.mkdir(path.join(appDir, "desktop"), { recursive: true });
  await fs.cp(electronDir, portableDir, { recursive: true });
  await fs.cp(path.join(root, "dist"), path.join(appDir, "dist"), { recursive: true });
  await fs.cp(path.join(root, "desktop", "main.cjs"), path.join(appDir, "desktop", "main.cjs"));
  await fs.writeFile(path.join(appDir, "package.json"), JSON.stringify({
    name: "datayao-portable",
    productName: "DataYao",
    version: packageJson.version,
    main: "desktop/main.cjs",
  }, null, 2));
  await fs.cp(path.join(root, "README.md"), path.join(portableDir, "README.md"));
  await fs.cp(path.join(root, "LICENSE"), path.join(portableDir, "LICENSE"));
  await fs.copyFile(path.join(portableDir, "electron.exe"), path.join(portableDir, "DataYao.exe"));
  await fs.rm(path.join(portableDir, "electron.exe"));

  // Set the executable icon via rcedit.
  const iconPath = path.join(root, "build", "icon.ico");
  if (fsSync.existsSync(iconPath)) {
    const rceditPaths = [
      path.join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe"),
      path.join(root, "node_modules", "@electron", "rcedit", "bin", "rcedit.exe"),
    ];
    const rcedit = rceditPaths.find((p) => fsSync.existsSync(p));
    if (rcedit) {
      const exePath = path.join(portableDir, "DataYao.exe");
      const r1 = spawnSync(rcedit, [exePath, "--set-icon", iconPath], { stdio: "inherit" });
      if (r1.status !== 0) throw new Error(`rcedit --set-icon failed with exit code ${r1.status}`);
      console.log("Set executable icon:", iconPath);
    } else {
      console.warn("rcedit.exe not found; skipping icon replacement on DataYao.exe");
    }
  } else {
    console.warn("build/icon.ico not found; skipping icon replacement. Run `npm run icons` first.");
  }

  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const source = path.join(portableDir, "*");
  const command = `Compress-Archive -Path ${quote(source)} -DestinationPath ${quote(zipPath)} -CompressionLevel Optimal`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Compress-Archive failed with exit code ${result.status}`);
  const archive = await fs.stat(zipPath);
  console.log(`Created ${zipPath} (${Math.round(archive.size / 1024 / 1024)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
