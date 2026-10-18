package main

// Native QR receiver for the Windows portable builds: avicap32 drives the
// camera preview, captured DIB frames are handed to a small pool of decode
// goroutines running the pure-Go ZXing port, and decoded DataYao frames go
// through the same fountain/protocol pipeline as the web receiver.

import (
	"fmt"
	"hash/crc32"
	"image"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/makiuchi-d/gozxing"
	"github.com/makiuchi-d/gozxing/qrcode"
)

const (
	idRecvStart  = 201
	idRecvSource = 202
	idRecvFormat = 203
	idRecvSave   = 204
	idRecvCopy   = 205
	idRecvText   = 206

	recvTimerID = 2

	wmAppReceiveDone = wmUser + 0x64

	wmCapStart            = wmUser
	wmCapSetCallbackFrame = wmCapStart + 5
	wmCapDriverConnect    = wmCapStart + 10
	wmCapDriverDisconnect = wmCapStart + 11
	wmCapDlgVideoFormat   = wmCapStart + 41
	wmCapDlgVideoSource   = wmCapStart + 42
	wmCapSetVideoFormat   = wmCapStart + 49
	wmCapSetPreview       = wmCapStart + 50
	wmCapSetPreviewRate   = wmCapStart + 52
	wmCapSetScale         = wmCapStart + 53
)

type videoHdr struct {
	lpData         uintptr
	dwBufferLength uint32
	dwBytesUsed    uint32
	dwTimeCaptured uint32
	dwUser         uintptr
	dwFlags        uint32
	dwReserved     [4]uintptr
}

type capturedFrame struct {
	pixels []byte
	width  int
	height int
}

type receiverState struct {
	window       uintptr
	capWindow    uintptr
	title        uintptr
	startButton  uintptr
	sourceButton uintptr
	formatButton uintptr
	saveButton   uintptr
	copyButton   uintptr
	textEdit     uintptr
	statusLabel  uintptr
	progress     uintptr
	diag         uintptr
	resultLabel  uintptr

	mu           sync.Mutex
	decoder      *fountainDecoder
	streamKey    string
	captured     int
	decoded      int
	validFrames  int
	done         bool
	failed       string
	result       *unpackedTransfer
	startedAt    time.Time
	dropCount    int64
	invalidQr    int64

	dibScratch []byte
	frames     chan capturedFrame
	quit       chan struct{}
	workers  sync.WaitGroup
	running  bool
	callback uintptr
}

var receiver receiverState
var receiverWindowCallback uintptr

func openReceiverWindow() error {
	if receiver.window != 0 {
		procSetForegroundWindow.Call(receiver.window)
		return nil
	}
	width := px(780)
	height := px(620)
	screenWidth, _, _ := procGetSystemMetrics.Call(smCxScreen)
	screenHeight, _, _ := procGetSystemMetrics.Call(smCyScreen)
	x := (int32(screenWidth) - width) / 2
	y := (int32(screenHeight) - height) / 2
	hwnd := createWindow(wsExAppWindow, receiverClassName, "DataYao 接收端 · 黑白 QR", wsOverlappedWindow|wsClipChildren, x, y, width, height, app.main, 0, app.instance)
	if hwnd == 0 {
		return fmt.Errorf("创建接收窗口失败")
	}
	showWindow(hwnd, swShow)
	procUpdateWindow.Call(hwnd)
	return nil
}

func receiverWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmCreate:
		receiver.window = hwnd
		createReceiverControls(hwnd)
		layoutReceiverControls(hwnd)
		procSetTimer.Call(hwnd, recvTimerID, uintptr(250), 0)
		return 0
	case wmSize:
		layoutReceiverControls(hwnd)
		return 0
	case wmGetMinMaxInfo:
		info := (*minMaxInfo)(unsafe.Pointer(lParam))
		info.minTrackSize.x = px(700)
		info.minTrackSize.y = px(540)
		return 0
	case wmCommand:
		handleReceiverCommand(lowWord(wParam), highWord(wParam))
		return 0
	case wmTimer:
		if wParam == recvTimerID {
			updateReceiverLabels()
			return 0
		}
	case wmAppReceiveDone:
		finishReceiverTransfer()
		return 0
	case wmDrawItem:
		return drawOwnerButton((*drawItemStruct)(unsafe.Pointer(lParam)))
	case wmCtlColorStatic:
		return colorStatic(wParam, lParam)
	case wmCtlColorEdit:
		procSetBkColor.Call(wParam, rgb(255, 255, 255))
		procSetTextColor.Call(wParam, rgb(34, 37, 43))
		return app.brushSurface
	case wmDestroy:
		stopReceiverCapture()
		procKillTimer.Call(hwnd, recvTimerID)
		receiver.window = 0
		return 0
	}
	return defaultWindowProc(hwnd, message, wParam, lParam)
}

func createReceiverControls(hwnd uintptr) {
	createLabel := func(text string, font uintptr) uintptr {
		handle := createWindow(0, "STATIC", text, wsChild|wsVisible|ssLeft|ssCenterImage, 0, 0, 10, 10, hwnd, 0, app.instance)
		sendMessage(handle, wmSetFont, font, 1)
		return handle
	}
	createButton := func(id int, text string) uintptr {
		handle := createWindow(0, "BUTTON", text, wsChild|wsVisible|wsTabStop|bsOwnerDraw, 0, 0, 10, 10, hwnd, uintptr(id), app.instance)
		sendMessage(handle, wmSetFont, app.fontMedium, 1)
		return handle
	}

	receiver.title = createLabel("接收", app.fontTitle)
	receiver.statusLabel = createLabel("摄像头未启动", app.fontMedium)
	receiver.startButton = createButton(idRecvStart, "启动摄像头并接收")
	receiver.sourceButton = createButton(idRecvSource, "选择摄像头")
	receiver.formatButton = createButton(idRecvFormat, "视频格式")
	receiver.progress = createLabel("等待数据流", app.font)
	receiver.diag = createLabel("启动后把发送屏幕对准摄像头,使用黑白 QR 模式", app.font)
	receiver.resultLabel = createLabel("", app.font)
	receiver.saveButton = createButton(idRecvSave, "保存文件")
	receiver.copyButton = createButton(idRecvCopy, "复制文本")
	receiver.textEdit = createWindow(wsExClientEdge, "EDIT", "", wsChild|wsBorder|esLeft|esMultiline|esAutoVScroll|esReadOnly|wsVScroll, 0, 0, 10, 10, hwnd, uintptr(idRecvText), app.instance)
	sendMessage(receiver.textEdit, wmSetFont, app.font, 1)
	enableWindow(receiver.saveButton, false)
	enableWindow(receiver.copyButton, false)
	showWindow(receiver.saveButton, swHide)
	showWindow(receiver.copyButton, swHide)
	showWindow(receiver.textEdit, swHide)
}

func layoutReceiverControls(hwnd uintptr) {
	client := getClientRectangle(hwnd)
	width := client.right - client.left
	height := client.bottom - client.top
	margin := px(24)
	controlHeight := px(38)
	labelHeight := px(24)

	moveWindow(receiver.title, margin, px(18), width-margin*2, px(40))
	moveWindow(receiver.statusLabel, margin, px(60), width-margin*2-px(230), labelHeight)
	moveWindow(receiver.startButton, width-margin-px(230), px(52), px(230), px(40))

	previewX := margin
	previewY := px(96)
	previewWidth := width/2 - margin - px(10)
	previewHeight := previewWidth * 3 / 4
	if receiver.capWindow != 0 {
		moveWindow(receiver.capWindow, previewX, previewY, previewWidth, previewHeight)
	}

	panelX := width/2 + px(10)
	panelWidth := width - panelX - margin
	moveWindow(receiver.sourceButton, panelX, previewY, panelWidth, controlHeight)
	moveWindow(receiver.formatButton, panelX, previewY+px(46), panelWidth, controlHeight)
	moveWindow(receiver.progress, panelX, previewY+px(100), panelWidth, labelHeight)
	moveWindow(receiver.diag, panelX, previewY+px(126), panelWidth, px(44))

	bottomY := previewY + previewHeight + px(16)
	moveWindow(receiver.resultLabel, margin, bottomY, width-margin*2, labelHeight)
	moveWindow(receiver.saveButton, margin, bottomY+px(30), px(150), controlHeight)
	moveWindow(receiver.copyButton, margin+px(160), bottomY+px(30), px(150), controlHeight)
	textY := bottomY + px(76)
	moveWindow(receiver.textEdit, margin, textY, width-margin*2, max32(height-textY-margin, px(60)))
}

func max32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}

func handleReceiverCommand(id, notification uint16) {
	if notification != bnClicked {
		return
	}
	switch id {
	case idRecvStart:
		if receiver.running {
			stopReceiverCapture()
		} else {
			startReceiverCapture()
		}
	case idRecvSource:
		if receiver.capWindow != 0 {
			sendMessage(receiver.capWindow, wmCapDlgVideoSource, 0, 0)
		}
	case idRecvFormat:
		if receiver.capWindow != 0 {
			sendMessage(receiver.capWindow, wmCapDlgVideoFormat, 0, 0)
		}
	case idRecvSave:
		saveReceiverResult()
	case idRecvCopy:
		copyReceiverText()
	}
}

func startReceiverCapture() {
	resetReceiverState()
	if receiver.capWindow == 0 {
		result, _, _ := procCapCreateCaptureWindowA.Call(
			uintptr(unsafe.Pointer(syscall.StringBytePtr("DataYaoCamera"))),
			wsChild|wsVisible,
			0, 0, 320, 240,
			receiver.window, 0x1984, app.instance,
		)
		if result == 0 {
			setReceiverStatus("无法创建摄像头窗口", true)
			return
		}
		receiver.capWindow = result
		layoutReceiverControls(receiver.window)
	}
	connected, _, _ := procSendMessageW.Call(receiver.capWindow, wmCapDriverConnect, 0, 0)
	if int32(connected) == 0 {
		setReceiverStatus("摄像头连接失败,请插入摄像头或用“选择摄像头”更换设备", true)
		return
	}
	requestRGBFormat(receiver.capWindow)
	if receiver.callback == 0 {
		receiver.callback = syscall.NewCallback(receiverFrameCallback)
	}
	sendMessage(receiver.capWindow, wmCapSetCallbackFrame, 0, receiver.callback)
	sendMessage(receiver.capWindow, wmCapSetScale, 1, 0)
	sendMessage(receiver.capWindow, wmCapSetPreviewRate, 66, 0)
	sendMessage(receiver.capWindow, wmCapSetPreview, 1, 0)

	workers := runtime.NumCPU() - 1
	if workers < 1 {
		workers = 1
	}
	if workers > 4 {
		workers = 4
	}
	receiver.frames = make(chan capturedFrame, workers)
	receiver.quit = make(chan struct{})
	receiver.workers.Add(workers)
	for index := 0; index < workers; index++ {
		go receiverDecodeLoop(receiver.frames, receiver.quit)
	}
	receiver.running = true
	receiver.mu.Lock()
	receiver.startedAt = time.Now()
	receiver.mu.Unlock()
	setReceiverStatus("正在扫描 DataYao 二维码…", false)
	setWindowText(receiver.startButton, "停止接收")
}

func stopReceiverCapture() {
	if !receiver.running {
		return
	}
	receiver.running = false
	if receiver.quit != nil {
		close(receiver.quit)
		receiver.workers.Wait()
		receiver.quit = nil
	}
	receiver.frames = nil
	if receiver.capWindow != 0 {
		sendMessage(receiver.capWindow, wmCapSetPreview, 0, 0)
		sendMessage(receiver.capWindow, wmCapSetCallbackFrame, 0, 0)
		sendMessage(receiver.capWindow, wmCapDriverDisconnect, 0, 0)
	}
	setReceiverStatus("摄像头已停止", false)
	setWindowText(receiver.startButton, "启动摄像头并接收")
}

func resetReceiverState() {
	receiver.mu.Lock()
	receiver.decoder = nil
	receiver.streamKey = ""
	receiver.captured = 0
	receiver.decoded = 0
	receiver.validFrames = 0
	receiver.done = false
	receiver.failed = ""
	receiver.result = nil
	receiver.startedAt = time.Time{}
	receiver.mu.Unlock()
	atomic.StoreInt64(&receiver.dropCount, 0)
	atomic.StoreInt64(&receiver.invalidQr, 0)
	showWindow(receiver.saveButton, swHide)
	showWindow(receiver.copyButton, swHide)
	showWindow(receiver.textEdit, swHide)
	enableWindow(receiver.saveButton, false)
	enableWindow(receiver.copyButton, false)
	setWindowText(receiver.textEdit, "")
	setWindowText(receiver.resultLabel, "")
}

func requestRGBFormat(capWindow uintptr) {
	// Ask for an uncompressed 640x480 24-bit stream; drivers that refuse keep
	// their default format and per-frame parsing handles what actually arrives.
	var info bitmapInfo
	info.header.size = uint32(unsafe.Sizeof(info.header))
	info.header.width = 640
	info.header.height = 480
	info.header.planes = 1
	info.header.bitCount = 24
	info.header.compression = biRGB
	procSendMessageW.Call(capWindow, wmCapSetVideoFormat, uintptr(unsafe.Pointer(&info)), uintptr(info.header.size))
}

func receiverFrameCallback(hwnd uintptr, header uintptr) uintptr {
	if !receiver.running || header == 0 {
		return 1
	}
	hdr := (*videoHdr)(unsafe.Pointer(header))
	if hdr.lpData == 0 || hdr.dwBytesUsed < 40 {
		return 1
	}
	// Copy the DIB immediately: the buffer is only valid during the callback.
	if int(hdr.dwBytesUsed) > len(receiver.dibScratch) {
		receiver.dibScratch = make([]byte, hdr.dwBytesUsed)
	}
	dib := receiver.dibScratch[:hdr.dwBytesUsed]
	copy(dib, (*[1 << 30]byte)(unsafe.Pointer(hdr.lpData))[:hdr.dwBytesUsed])
	frame := dibToGrayscale(dib)
	if frame == nil {
		return 1
	}
	receiver.mu.Lock()
	receiver.captured++
	receiver.mu.Unlock()

	// Latest-wins hand-off: never block the capture callback; when the queue
	// is full the oldest frame is discarded to make room for the fresh one.
	select {
	case receiver.frames <- *frame:
	default:
		select {
		case <-receiver.frames:
		default:
		}
		select {
		case receiver.frames <- *frame:
		default:
		}
		atomic.AddInt64(&receiver.dropCount, 1)
	}
	return 1
}

// dibToGrayscale converts a bottom-up or top-down BI_RGB DIB into decimated
// grayscale pixels ready for the QR decoder.
func dibToGrayscale(dib []byte) *capturedFrame {
	if len(dib) < 40 {
		return nil
	}
	header := (*bitmapInfoHeader)(unsafe.Pointer(&dib[0]))
	if header.compression != biRGB || (header.bitCount != 24 && header.bitCount != 32) {
		return nil
	}
	width := int(header.width)
	if width <= 0 {
		return nil
	}
	flipped := true
	height := int(header.height)
	if height < 0 {
		height = -height
		flipped = false
	}
	if width < 32 || height < 32 {
		return nil
	}
	bytesPerPixel := int(header.bitCount) / 8
	stride := (width*bytesPerPixel + 3) &^ 3
	if len(dib) < stride*height {
		return nil
	}

	step := 1
	if width > 960 {
		step = 2
	}
	outWidth := (width + step - 1) / step
	outHeight := (height + step - 1) / step
	pixels := make([]byte, outWidth*outHeight)
	for row := 0; row < outHeight; row++ {
		sourceRow := row * step
		if flipped {
			sourceRow = height - 1 - sourceRow
		}
		rowStart := sourceRow * stride
		for column := 0; column < outWidth; column++ {
			offset := rowStart + column*step*bytesPerPixel
			// BT.601 luma; QR modules survive any reasonable weighting.
			pixels[row*outWidth+column] = byte((int(dib[offset])*30 + int(dib[offset+1])*59 + int(dib[offset+2])*11) / 100)
		}
	}
	return &capturedFrame{pixels: pixels, width: outWidth, height: outHeight}
}

// rawBytesFromResult prefers the byte-segment metadata: gozxing's RawBytes
// carries the full data codewords including the QR pad stream (0xEC/0x11),
// while the concatenated BYTE segments are exactly the encoded payload.
func rawBytesFromResult(result *gozxing.Result) []byte {
	metadata := result.GetResultMetadata()
	if metadata == nil {
		return result.GetRawBytes()
	}
	segments, ok := metadata[gozxing.ResultMetadataType_BYTE_SEGMENTS].([][]byte)
	if !ok || len(segments) == 0 {
		return result.GetRawBytes()
	}
	total := 0
	for _, segment := range segments {
		total += len(segment)
	}
	merged := make([]byte, 0, total)
	for _, segment := range segments {
		merged = append(merged, segment...)
	}
	return merged
}

// decodeQrGray runs the vendored pure-Go decoder. The generic detector in
// gozxing mis-samples a small share of cleanly rendered frames; the
// pure-barcode retry path recovers those, and anything still failing is left
// to the fountain code (dynamic streams tolerate frame loss).
func decodeQrGray(img *image.Gray) (*gozxing.Result, error) {
	bitmap, err := gozxing.NewBinaryBitmapFromImage(img)
	if err != nil {
		return nil, err
	}
	reader := qrcode.NewQRCodeReader()
	result, err := reader.DecodeWithoutHints(bitmap)
	if err == nil {
		return result, nil
	}
	retry, err := gozxing.NewBinaryBitmapFromImage(img)
	if err != nil {
		return nil, err
	}
	hints := map[gozxing.DecodeHintType]interface{}{gozxing.DecodeHintType_PURE_BARCODE: true}
	return reader.Decode(retry, hints)
}

func receiverDecodeLoop(frames <-chan capturedFrame, quit <-chan struct{}) {
	defer receiver.workers.Done()
	for {
		select {
		case <-quit:
			return
		case frame := <-frames:
			gray := &image.Gray{
				Pix:    frame.pixels,
				Stride: frame.width,
				Rect:   image.Rect(0, 0, frame.width, frame.height),
			}
			result, err := decodeQrGray(gray)
			receiver.mu.Lock()
			receiver.decoded++
			receiver.mu.Unlock()
			if err != nil {
				continue
			}
			raw := rawBytesFromResult(result)
			if len(raw) == 0 {
				continue
			}
			acceptReceiverFrame(raw)
		}
	}
}

func acceptReceiverFrame(raw []byte) {
	header, block, err := parseFrame(raw)
	if err != nil {
		atomic.AddInt64(&receiver.invalidQr, 1)
		return
	}
	key := streamKey(header)
	receiver.mu.Lock()
	defer receiver.mu.Unlock()
	if receiver.done {
		return
	}
	if key != receiver.streamKey {
		receiver.decoder = newFountainDecoder(int(header.blockCount), int(header.blockSize), header.sessionID, int(header.totalLength))
		receiver.streamKey = key
		if receiver.startedAt.IsZero() {
			receiver.startedAt = time.Now()
		}
	}
	decoder := receiver.decoder
	if decoder == nil {
		return
	}
	decoder.add(header.sequence, block)
	receiver.validFrames = decoder.framesNew
	if !decoder.complete() {
		return
	}
	container := decoder.assemble()
	if container == nil {
		return
	}
	if crc32.ChecksumIEEE(container) != header.payloadCRC {
		receiver.failed = "CRC32 校验失败,请重新发送"
		receiver.done = true
	} else if unpacked, err := unpackTransfer(container); err != nil {
		receiver.failed = err.Error()
		receiver.done = true
	} else {
		receiver.result = unpacked
		receiver.done = true
	}
	procPostMessageW.Call(receiver.window, wmAppReceiveDone, 0, 0)
}

func finishReceiverTransfer() {
	stopReceiverCapture()
	receiver.mu.Lock()
	result := receiver.result
	failure := receiver.failed
	receiver.mu.Unlock()
	if result != nil {
		setReceiverStatus("接收完成 · SHA-256 校验通过", false)
		if result.isText {
			showWindow(receiver.textEdit, swShow)
			setWindowText(receiver.textEdit, string(result.bytes))
			showWindow(receiver.copyButton, swShow)
			enableWindow(receiver.copyButton, true)
		} else {
			setWindowText(receiver.resultLabel, fmt.Sprintf("已恢复文件:%s · %s", result.fileName, formatBytes(int64(len(result.bytes)))))
			showWindow(receiver.saveButton, swShow)
			enableWindow(receiver.saveButton, true)
		}
	} else if failure != "" {
		setReceiverStatus(failure, true)
	}
}

func updateReceiverLabels() {
	if receiver.window == 0 {
		return
	}
	receiver.mu.Lock()
	captured := receiver.captured
	decoded := receiver.decoded
	decoder := receiver.decoder
	started := receiver.startedAt
	valid := receiver.validFrames
	receiver.mu.Unlock()

	if decoder != nil {
		rate := 0.0
		if !started.IsZero() {
			if elapsed := time.Since(started).Seconds(); elapsed > 0.2 {
				rate = float64(valid) / elapsed
			}
		}
		setWindowText(receiver.progress, fmt.Sprintf("有效帧 %d · 重复 %d · 已解块 %d/%d · %.1f 帧/s",
			valid, decoder.framesRepeat, decoder.solvedCount, decoder.blockCount, rate))
	} else if atomic.LoadInt64(&receiver.invalidQr) > 0 {
		setWindowText(receiver.progress, fmt.Sprintf("已识别 %d 个二维码,但不是 DataYao 帧", atomic.LoadInt64(&receiver.invalidQr)))
	} else {
		setWindowText(receiver.progress, "等待数据流")
	}
	setWindowText(receiver.diag, fmt.Sprintf("采集 %d · 解码 %d · 丢帧 %d · 解码线程随 CPU 自动分配",
		captured, decoded, atomic.LoadInt64(&receiver.dropCount)))
}

func setReceiverStatus(text string, isError bool) {
	setWindowText(receiver.statusLabel, text)
	if isError {
		setWindowText(receiver.progress, "未识别到 DataYao 数据流")
	}
}

func saveReceiverResult() {
	receiver.mu.Lock()
	result := receiver.result
	receiver.mu.Unlock()
	if result == nil {
		return
	}
	filter := "所有文件\000*.*\000"
	data := make([]uint16, 512)
	copy(data, syscall.StringToUTF16(result.fileName))
	title := utf16Pointer("保存接收的文件")
	ofn := openFileName{
		structSize: uint32(unsafe.Sizeof(openFileName{})),
		owner:      receiver.window,
		filter:     utf16Pointer(filter),
		file:       &data[0],
		maxFile:    uint32(len(data)),
		title:      title,
		flags:      ofNOverwritePrompt | ofNPathMustExist | ofNExplorer | ofNNoChangeDir,
	}
	chosen, _, _ := procGetSaveFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if chosen == 0 {
		return
	}
	path := syscall.UTF16ToString(data)
	file, err := os.Create(path)
	if err != nil {
		setReceiverStatus(fmt.Sprintf("无法保存文件:%v", err), true)
		return
	}
	if _, err = file.Write(result.bytes); err != nil {
		file.Close()
		setReceiverStatus(fmt.Sprintf("写入失败:%v", err), true)
		return
	}
	file.Close()
	setReceiverStatus(fmt.Sprintf("已保存到 %s", path), false)
}

func copyReceiverText() {
	receiver.mu.Lock()
	result := receiver.result
	receiver.mu.Unlock()
	if result == nil || !result.isText {
		return
	}
	encoded := syscall.StringToUTF16(string(result.bytes))
	handle, _, _ := procGlobalAlloc.Call(gmemMoveable, uintptr(len(encoded)*2))
	if handle == 0 {
		return
	}
	pointer, _, _ := procGlobalLock.Call(handle)
	if pointer == 0 {
		return
	}
	copy((*[1 << 28]uint16)(unsafe.Pointer(pointer))[:len(encoded)], encoded)
	procGlobalUnlock.Call(handle)
	if opened, _, _ := procOpenClipboard.Call(receiver.window); opened != 0 {
		procEmptyClipboard.Call()
		procSetClipboardData.Call(cfUnicodeText, handle)
		procCloseClipboard.Call()
		setReceiverStatus("文本已复制到剪贴板", false)
	}
}
