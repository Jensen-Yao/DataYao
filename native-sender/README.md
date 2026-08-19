DataYao Native Sender
=====================

This package is the sender-only, fully offline Windows edition of DataYao.
It does not need installation, Node.js, .NET, WebView2, a browser, or network access.

Packages
--------

- XP / Windows 7 x86: built with Go 1.10.8 and GO386=387 for older 32-bit computers.
- Windows 10 / 11 x64: built with the current 64-bit Go toolchain.

Both packages use the same DataYao protocol and work with the Android,
HarmonyOS, and Web receivers.

Usage
-----

1. Run DataYao.exe.
2. In File mode, click the file area or drag one file into the window.
3. In Text mode, enter the text to send.
4. Choose Black/White QR, Color QR, or Sound.
5. For QR modes, choose bytes per frame, frame rate, and QR error correction.
   For Sound, choose 64/96/128 bytes per block and the Stable/Fast profile.
6. Select Start. Keep the complete QR visible to the camera, or place the
   receiving phone near the speaker for Sound mode.
7. Use the QR size slider when the code is too large for the camera view.
   The Full Screen button and a double-click on the QR area toggle full screen.

Limits and privacy
------------------

- QR modes support up to 64 MB; Sound mode is limited to 64 KB and is intended
  for short text or small files.
- This is a one-way screen/camera or speaker/microphone channel. The sender
  receives no ACK.
- Transfer data is not encrypted. CRC32 and SHA-256 are integrity checks only.
- Files, text, and telemetry are never uploaded by this application.

Recommended starting settings
-----------------------------

- 1200 bytes/frame, 15 fps, ECC-L.
- For difficult cameras: 800 bytes/frame, 10 fps, ECC-M.
- For fast modern devices: 1600-2300 bytes/frame and 20-30 fps.
- Color QR carries three DataYao frames per image. Use it only when the receiver
  can keep all three color channels in focus and without display color filters.
- Sound starts around 8-12 bytes/second. Keep devices close and the room quiet.

Project: https://github.com/Jensen-Yao/DataYao
