param(
  [string]$LegacyGo = "",
  [string]$ModernGo = "",
  [switch]$RegenerateIcons
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $root "artifacts\native"))
$gopath = [IO.Path]::GetFullPath((Join-Path $root "native-sender"))
$packageJson = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = [string]$packageJson.version

function Resolve-GoExecutable([string]$provided, [string[]]$candidates) {
  $paths = @()
  if ($provided) { $paths += $provided }
  $paths += $candidates
  foreach ($candidate in $paths) {
    if (-not $candidate) { continue }
    $full = [IO.Path]::GetFullPath($candidate)
    if (Test-Path -LiteralPath $full -PathType Container) {
      $full = Join-Path $full "bin\go.exe"
    }
    if (Test-Path -LiteralPath $full -PathType Leaf) { return $full }
  }
  throw "Go toolchain not found. Pass -LegacyGo and -ModernGo with go.exe or GOROOT paths."
}

function Assert-UnderOutput([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  $prefix = $outputRoot.TrimEnd('\') + '\'
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside $outputRoot`: $full"
  }
}

function Invoke-Go([string]$go, [string[]]$arguments) {
  & $go @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Go command failed ($LASTEXITCODE): $go $($arguments -join ' ')"
  }
}

function Assert-PeMachine([string]$path, [int]$expected) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  if ($machine -ne $expected) {
    throw ("Unexpected PE machine 0x{0:x4} for {1}" -f $machine, $path)
  }
}

function Get-Sha256Hex([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash($stream)
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Write-Package([string]$archiveName, [string]$folderName, [string]$exePath) {
  $stagingRoot = Join-Path $outputRoot "staging"
  $packageDir = Join-Path $stagingRoot $folderName
  $archivePath = Join-Path $outputRoot $archiveName
  Assert-UnderOutput $stagingRoot
  Assert-UnderOutput $packageDir
  Assert-UnderOutput $archivePath
  if (Test-Path -LiteralPath $packageDir) { Remove-Item -LiteralPath $packageDir -Recurse -Force }
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
  Copy-Item -LiteralPath $exePath -Destination (Join-Path $packageDir "DataYao.exe")
  Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination (Join-Path $packageDir "LICENSE.txt")
  Copy-Item -LiteralPath (Join-Path $root "native-sender\third_party\go-qrcode-LICENSE.txt") -Destination (Join-Path $packageDir "THIRD-PARTY-LICENSES.txt")
  $readme = Get-Content -LiteralPath (Join-Path $root "native-sender\README.md") -Raw -Encoding UTF8
  [IO.File]::WriteAllText((Join-Path $packageDir "README.txt"), $readme, (New-Object Text.UTF8Encoding($true)))
  Compress-Archive -Path $packageDir -DestinationPath $archivePath -CompressionLevel Optimal
  return $archivePath
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

if ($RegenerateIcons) {
  & node (Join-Path $root "scripts\generate-icons.cjs")
  if ($LASTEXITCODE -ne 0) { throw "Icon generation failed." }
}

$legacyGoExe = Resolve-GoExecutable $LegacyGo @(
  (Join-Path $root "artifacts\toolchains\go1.10.8-386\go\bin\go.exe")
)
$modernGoExe = Resolve-GoExecutable $ModernGo @(
  (Join-Path $root "artifacts\toolchains\go1.26.5-amd64-complete\go\bin\go.exe"),
  (Join-Path $root "artifacts\toolchains\go1.26.5-amd64\go\bin\go.exe")
)

$legacyExe = Join-Path $outputRoot "DataYao-Sender-XP-Win7-x86.exe"
$modernExe = Join-Path $outputRoot "DataYao-Sender-Win10-Win11-x64.exe"
$env:GOPATH = $gopath
$env:GO111MODULE = "off"
$env:GOOS = "windows"

Write-Host "Testing and building Legacy x86 with $legacyGoExe"
$env:GOARCH = "386"
$env:GO386 = "387"
Invoke-Go $legacyGoExe @("test", "datayaosender")
Invoke-Go $legacyGoExe @("build", "-ldflags", "-H windowsgui -s -w -X main.version=$version -X main.buildTarget=XP-Win7-x86", "-o", $legacyExe, "datayaosender")
Assert-PeMachine $legacyExe 0x014c

Write-Host "Testing and building Modern x64 with $modernGoExe"
$env:GOARCH = "amd64"
Remove-Item Env:GO386 -ErrorAction SilentlyContinue
Invoke-Go $modernGoExe @("test", "datayaosender")
Invoke-Go $modernGoExe @("build", "-ldflags", "-H windowsgui -s -w -X main.version=$version -X main.buildTarget=Win10-11-x64", "-o", $modernExe, "datayaosender")
Assert-PeMachine $modernExe 0x8664

$rceditCandidates = @(
  (Join-Path $root "node_modules\electron-winstaller\vendor\rcedit.exe"),
  (Join-Path $root "node_modules\@electron\rcedit\bin\rcedit.exe")
)
$rcedit = $rceditCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $rcedit) { throw "rcedit.exe not found. Run npm ci --ignore-scripts before packaging." }
$iconPath = Join-Path $root "build\icon.ico"
foreach ($exe in @($legacyExe, $modernExe)) {
  & $rcedit $exe --set-icon $iconPath
  if ($LASTEXITCODE -ne 0) { throw "Unable to apply the DataYao icon to $exe" }
}

foreach ($exe in @($legacyExe, $modernExe)) {
  $selfTest = "$exe.self-test.png"
  Assert-UnderOutput $selfTest
  if (Test-Path -LiteralPath $selfTest) { Remove-Item -LiteralPath $selfTest -Force }
  $process = Start-Process -FilePath $exe -ArgumentList ('--self-test "{0}"' -f $selfTest) -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $selfTest)) {
    throw "QR self-test failed for $exe"
  }
  Remove-Item -LiteralPath $selfTest -Force
}

$legacyZip = Write-Package "DataYao-$version-Windows-XP-Win7-x86-Portable.zip" "DataYao-Sender-XP-Win7-x86" $legacyExe
$modernZip = Write-Package "DataYao-$version-Windows-Win10-Win11-x64-Portable.zip" "DataYao-Sender-Win10-Win11-x64" $modernExe

$checksumTargets = @($legacyZip, $modernZip)
$checksumLines = foreach ($item in $checksumTargets) {
  $hash = Get-Sha256Hex $item
  "$hash  $([IO.Path]::GetFileName($item))"
}
[IO.File]::WriteAllLines((Join-Path $outputRoot "SHA256SUMS.txt"), $checksumLines, [Text.Encoding]::ASCII)

Write-Host "Created native Windows packages:"
Get-Item -LiteralPath $legacyExe, $modernExe, $legacyZip, $modernZip | Select-Object Name, Length
