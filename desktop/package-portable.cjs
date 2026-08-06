const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const outputRoot = path.join(root, "artifacts", "desktop");
const portableDir = path.join(outputRoot, "DataYao");
const appDir = path.join(portableDir, "resources", "app");
const electronDir = path.join(root, "node_modules", "electron", "dist");
const zipPath = path.join(outputRoot, `DataYao-${packageJson.version}-Windows-x64-Portable.zip`);

async function main() {
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

