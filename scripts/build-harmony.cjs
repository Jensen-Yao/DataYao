const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const harmony = path.join(root, "harmony");
const dist = path.join(root, "dist-harmony");
const rawfile = path.join(harmony, "entry", "src", "main", "resources", "rawfile", "datayao");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
    shell: options.shell || false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? "unknown"}`);
  }
}

function syncWebAssets() {
  if (!fs.existsSync(dist)) {
    throw new Error(`Missing ${dist}; the Harmony web build did not produce dist-harmony.`);
  }
  fs.rmSync(rawfile, { recursive: true, force: true });
  fs.mkdirSync(rawfile, { recursive: true });
  for (const item of fs.readdirSync(dist)) {
    fs.cpSync(path.join(dist, item), path.join(rawfile, item), { recursive: true });
  }

  const index = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b1118" />
    <link rel="stylesheet" href="./assets/datayao.css" />
    <title>DataYao</title>
  </head>
  <body>
    <div id="root"></div>
    <script>window.global = window.global || window;</script>
    <script src="./assets/datayao.js"></script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(rawfile, "index.html"), index, "utf8");
}

function findHvigor() {
  const local = path.join(harmony, "node_modules", "@ohos", "hvigor", "bin", "hvigor.js");
  if (fs.existsSync(local)) return local;
  const bundled = path.join("F:", "Huawei", "DevEco Studio", "tools", "hvigor", "bin", "hvigorw.js");
  if (fs.existsSync(bundled)) return bundled;
  throw new Error("Hvigor was not found. Install DevEco Studio or run npm install in harmony/.");
}

function buildApp() {
  const sdk = process.env.DEVECO_SDK_HOME || path.join("F:", "Huawei", "DevEco Studio", "sdk");
  const env = {
    VITE_RECEIVER_ONLY: "1",
    VITE_HARMONY: "1",
    DEVECO_SDK_HOME: sdk,
    OHOS_BASE_SDK_HOME: process.env.OHOS_BASE_SDK_HOME || path.join(sdk, "default", "openharmony"),
  };
  const hvigor = findHvigor();
  run(process.execPath, [hvigor, "-p", "product=default", "assembleApp", "--no-daemon"], { cwd: harmony, env });
}

function copyArtifact() {
  const outputDir = path.join(harmony, "build", "outputs");
  const apps = [];
  if (fs.existsSync(outputDir)) {
    for (const file of fs.readdirSync(outputDir, { recursive: true })) {
      if (typeof file === "string" && file.endsWith(".app")) apps.push(path.join(outputDir, file));
    }
  }
  const unsigned = apps.find((file) => file.toLowerCase().includes("unsigned"));
  const artifact = unsigned || apps[0];
  if (!artifact || !fs.existsSync(artifact)) {
    throw new Error("Hvigor completed but no HarmonyOS .app package was found.");
  }
  const output = path.join(root, "artifacts", "harmony", `DataYao-${packageJson.version}-HarmonyOS-${unsigned ? "unsigned" : "local"}.app`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(artifact, output);
  console.log(`HarmonyOS package: ${output}`);
  console.log(unsigned
    ? "This package is unsigned. Create a DataYao-specific AGC Profile before release signing."
    : "The local package was signed by the configured DevEco material; verify its bundle and profile before upload.");
}

try {
  run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-b", "--pretty", "false"]);
  run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.config.harmony.ts"], {
    env: { VITE_RECEIVER_ONLY: "1", VITE_HARMONY: "1" }
  });
  syncWebAssets();
  buildApp();
  copyArtifact();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
