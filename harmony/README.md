# DataYao HarmonyOS Receiver

This directory is a standalone HarmonyOS Stage project for the receiver-only DataYao application.

## Identity

- Bundle name: `io.github.jensenyao.datayao`
- Version: `0.2.0` (`versionCode` 2)
- Devices: phone, tablet, 2in1
- Permission: `ohos.permission.CAMERA`
- Web entry: `entry/src/main/resources/rawfile/datayao/index.html`

Open this `harmony` directory directly in DevEco Studio. Do not open the repository root as a Harmony project.

## Build

From the repository root:

```powershell
npm.cmd run build:harmony
```

The command builds the receiver-only Web bundle, synchronizes it into `rawfile/datayao`, invokes Hvigor, and copies the local `.app` package to `artifacts/harmony/`.

The repository intentionally contains no release signing material. A store upload requires a DataYao-specific AGC application, release certificate chain, `.p12`, and release Profile matching `io.github.jensenyao.datayao`. Never reuse another application's Profile or commit signing files and passwords.
