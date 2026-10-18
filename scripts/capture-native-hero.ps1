param(
  [string]$ExePath = "",
  [string]$OutputPath = "",
  [string]$Text = "DataYao-v0.4.0-offline-transfer"
)

# Captures the native sender window with PrintWindow (PW_RENDERFULLCONTENT),
# which reads the window's own surface and is immune to occlusion,
# offscreen positioning, and foreground-focus stealing.

$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
if (-not $ExePath) { $ExePath = Join-Path $root "artifacts\native\DataYao-Win10-Win11-x64.exe" }
if (-not $OutputPath) { $OutputPath = Join-Path $root "public\datayao-native-sender.png" }
$ExePath = [IO.Path]::GetFullPath($ExePath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw "Native EXE not found: $ExePath" }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# Physical-pixel window coordinates; without this a scaled display returns
# virtualized logical sizes and the capture clips the window.
[void][WinShot]::SetProcessDPIAware()

$process = Start-Process -FilePath $ExePath -ArgumentList @("--test-text", $Text) -PassThru -WindowStyle Normal
try {
  $deadline = (Get-Date).AddSeconds(20)
  while ($process.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline -and -not $process.HasExited) {
    Start-Sleep -Milliseconds 300
    $process.Refresh()
  }
  if ($process.MainWindowHandle -eq 0) { throw "Native sender window never appeared" }
  # Let the transfer spin up and render several QR frames.
  Start-Sleep -Seconds 4

  $rect = New-Object WinShot+RECT
  if (-not [WinShot]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) { throw "GetWindowRect failed" }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw "Empty window rect" }

  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  # flags=0: the sender is plain GDI (StretchDIBits), and the
  # PW_RENDERFULLCONTENT path returns red-channel-corrupted content for it.
  $ok = [WinShot]::PrintWindow($process.MainWindowHandle, $hdc, 0)
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
  if (-not $ok) { $bitmap.Dispose(); throw "PrintWindow failed" }

  # GDI PrintWindow writes correct RGB but leaves the alpha channel at 0,
  # which corrupts colors once saved as PNG; force alpha to 255.
  $opaque = New-Object System.Drawing.Bitmap($width, $height)
  $clean = [System.Drawing.Graphics]::FromImage($opaque)
  $clean.Clear([System.Drawing.Color]::White)
  $matrix = New-Object System.Drawing.Imaging.ColorMatrix
  $matrix.Matrix33 = 1.0
  $attributes = New-Object System.Drawing.Imaging.ImageAttributes
  $attributes.SetColorMatrix($matrix)
  $rectFull = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
  $clean.DrawImage($bitmap, $rectFull, 0, 0, $width, $height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
  $clean.Dispose()
  $bitmap.Dispose()
  $bitmap = $opaque

  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($OutputPath)) -Force | Out-Null
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Output "captured ${width}x${height} -> $OutputPath"
}
finally {
  if (-not $process.HasExited) {
    $process.CloseMainWindow() | Out-Null
    Start-Sleep -Milliseconds 800
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
}
