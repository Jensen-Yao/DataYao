package main

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io/ioutil"
	"mime"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	qrcode "github.com/skip2/go-qrcode"
)

var (
	version     = "dev"
	buildTarget = "Windows"
)

const (
	mainClassName = "DataYaoNativeMain"
	qrClassName   = "DataYaoNativeQR"
	dropClassName = "DataYaoNativeDrop"

	idModeFile = 101
	idModeText = 102
	idTextEdit = 103
	idBlock    = 104
	idFPS      = 105
	idECC      = 106
	idStart    = 107
	idFull     = 108
	idScale    = 109
	idCarrier  = 110

	modeFile     = 0
	modeText     = 1
	carrierQR    = 0
	carrierColor = 1
	carrierSound = 2

	frameTimerID = 1
)

type appState struct {
	instance       uintptr
	main           uintptr
	drop           uintptr
	textEdit       uintptr
	modeFileButton uintptr
	modeTextButton uintptr
	blockCombo     uintptr
	fpsCombo       uintptr
	eccCombo       uintptr
	carrierCombo   uintptr
	startButton    uintptr
	fullButton     uintptr
	scaleTrack     uintptr
	scaleValue     uintptr
	statusLabel    uintptr
	metricsLabel   uintptr
	rateLabel      uintptr
	versionLabel   uintptr
	settingLabels  []uintptr
	qrWindow       uintptr
	fullWindow     uintptr

	font               uintptr
	fontMedium         uintptr
	fontTitle          uintptr
	brushBackground    uintptr
	brushSurface       uintptr
	brushStage         uintptr
	brushAccent        uintptr
	brushAccentPressed uintptr
	brushText          uintptr
	brushMutedBorder   uintptr
	brushDanger        uintptr
	iconLarge          uintptr
	iconSmall          uintptr
	iconOwned          bool

	dpi          int32
	mode         int
	carrier      int
	filePath     string
	fileSize     int64
	statusError  bool
	running      bool
	blockSize    int
	fps          int
	ecc          qrcode.RecoveryLevel
	audioProfile audioProfile
	qrScale      int
	qrPixels     []uint32
	qrModules    int
	qrVersion    int
	sequence     uint32
	payload      *transferPayload
	encoder      *fountainEncoder
	header       frameHeader
	audioWav     []byte
}

var app appState
var mainCallback uintptr
var qrCallback uintptr
var dropCallback uintptr
var startupTestText string
var startupTestFile string

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--self-test" {
		if err := writeSelfTestQR(os.Args[2]); err != nil {
			os.Exit(2)
		}
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "--test-text" {
		startupTestText = os.Args[2]
	}
	if len(os.Args) == 3 && os.Args[1] == "--test-file" {
		startupTestFile = os.Args[2]
	}

	runtime.LockOSThread()
	if procSetProcessDPIAware.Find() == nil {
		procSetProcessDPIAware.Call()
	}
	dpiAware := false
	if procIsProcessDPIAware.Find() == nil {
		result, _, _ := procIsProcessDPIAware.Call()
		dpiAware = result != 0
	}
	initializeDPI(dpiAware)
	initializeCommonControls()
	if err := initializeResources(); err != nil {
		messageBox(0, "DataYao 无法启动", err.Error())
		return
	}
	defer releaseResources()
	if err := registerWindowClasses(); err != nil {
		messageBox(0, "DataYao 无法启动", err.Error())
		return
	}
	if err := createMainWindow(); err != nil {
		messageBox(0, "DataYao 无法启动", err.Error())
		return
	}
	runMessageLoop()
}

func initializeDPI(dpiAware bool) {
	app.dpi = 96
	if !dpiAware {
		return
	}
	hdc, _, _ := procGetDC.Call(0)
	if hdc != 0 {
		value, _, _ := procGetDeviceCaps.Call(hdc, logPixelsX)
		if value >= 72 && value <= 384 {
			app.dpi = int32(value)
		}
		procReleaseDC.Call(0, hdc)
	}
}

func px(value int32) int32 {
	return value * app.dpi / 96
}

func initializeCommonControls() {
	controls := initCommonControlsEx{size: uint32(unsafe.Sizeof(initCommonControlsEx{})), icc: iccBarClasses}
	procInitCommonControlsEx.Call(uintptr(unsafe.Pointer(&controls)))
}

func initializeResources() error {
	instance, _, _ := procGetModuleHandleW.Call(0)
	if instance == 0 {
		return fmt.Errorf("无法获取程序实例")
	}
	app.instance = instance
	loadProductIcons()
	app.brushBackground = createBrush(rgb(246, 247, 249))
	app.brushSurface = createBrush(rgb(255, 255, 255))
	app.brushStage = createBrush(rgb(235, 238, 242))
	app.brushAccent = createBrush(rgb(0, 113, 227))
	app.brushAccentPressed = createBrush(rgb(0, 91, 186))
	app.brushText = createBrush(rgb(34, 37, 43))
	app.brushMutedBorder = createBrush(rgb(205, 210, 218))
	app.brushDanger = createBrush(rgb(194, 57, 52))
	app.font = createFont(-px(15), 400)
	app.fontMedium = createFont(-px(15), 600)
	app.fontTitle = createFont(-px(28), 650)
	if app.font == 0 || app.fontMedium == 0 || app.fontTitle == 0 {
		return fmt.Errorf("无法创建界面字体")
	}
	app.mode = modeFile
	app.carrier = carrierQR
	app.blockSize = 1200
	app.fps = 15
	app.ecc = qrcode.Low
	app.audioProfile = audioStable
	app.qrScale = 85
	return nil
}

func createFont(height int32, weight int32) uintptr {
	result, _, _ := procCreateFontW.Call(
		uintptr(height), 0, 0, 0, uintptr(weight),
		0, 0, 0, 1, 0, 0, 5, 0,
		uintptr(unsafe.Pointer(utf16Pointer("Microsoft YaHei UI"))),
	)
	return result
}

func loadProductIcons() {
	path, err := os.Executable()
	if err == nil {
		pathPointer := utf16Pointer(path)
		if procPrivateExtractIconsW.Find() == nil {
			var large uintptr
			var largeID uint32
			largeCount, _, _ := procPrivateExtractIconsW.Call(
				uintptr(unsafe.Pointer(pathPointer)), 0, 256, 256,
				uintptr(unsafe.Pointer(&large)), uintptr(unsafe.Pointer(&largeID)), 1, 0,
			)
			var small uintptr
			var smallID uint32
			smallCount, _, _ := procPrivateExtractIconsW.Call(
				uintptr(unsafe.Pointer(pathPointer)), 0, 32, 32,
				uintptr(unsafe.Pointer(&small)), uintptr(unsafe.Pointer(&smallID)), 1, 0,
			)
			if largeCount > 0 && large != 0 {
				app.iconLarge = large
				app.iconOwned = true
			}
			if smallCount > 0 && small != 0 {
				app.iconSmall = small
				app.iconOwned = true
			}
		}
	}
	if app.iconLarge == 0 && err == nil {
		var large uintptr
		var small uintptr
		count, _, _ := procExtractIconExW.Call(
			uintptr(unsafe.Pointer(utf16Pointer(path))),
			0,
			uintptr(unsafe.Pointer(&large)),
			uintptr(unsafe.Pointer(&small)),
			1,
		)
		if count > 0 {
			app.iconLarge = large
			if app.iconSmall == 0 {
				app.iconSmall = small
			} else if small != 0 {
				procDestroyIcon.Call(small)
			}
			app.iconOwned = true
		}
	}
	if app.iconLarge == 0 {
		app.iconLarge, _, _ = procLoadIconW.Call(0, idiApplication)
	}
	if app.iconSmall == 0 {
		app.iconSmall = app.iconLarge
	}
}

func releaseResources() {
	deleteObject(app.font)
	deleteObject(app.fontMedium)
	deleteObject(app.fontTitle)
	deleteObject(app.brushBackground)
	deleteObject(app.brushSurface)
	deleteObject(app.brushStage)
	deleteObject(app.brushAccent)
	deleteObject(app.brushAccentPressed)
	deleteObject(app.brushText)
	deleteObject(app.brushMutedBorder)
	deleteObject(app.brushDanger)
	if app.iconOwned && app.iconSmall != 0 && app.iconSmall != app.iconLarge {
		procDestroyIcon.Call(app.iconSmall)
	}
	if app.iconOwned && app.iconLarge != 0 {
		procDestroyIcon.Call(app.iconLarge)
	}
}

func registerWindowClasses() error {
	mainCallback = syscall.NewCallback(mainWindowProc)
	qrCallback = syscall.NewCallback(qrWindowProc)
	dropCallback = syscall.NewCallback(dropWindowProc)
	cursor, _, _ := procLoadCursorW.Call(0, idcArrow)
	classes := []struct {
		name       string
		callback   uintptr
		style      uint32
		background uintptr
	}{
		{mainClassName, mainCallback, csHRedraw | csVRedraw, app.brushBackground},
		{qrClassName, qrCallback, csHRedraw | csVRedraw | csDoubleClicks, app.brushStage},
		{dropClassName, dropCallback, csHRedraw | csVRedraw, app.brushSurface},
	}
	for _, item := range classes {
		class := wndClassEx{
			size:       uint32(unsafe.Sizeof(wndClassEx{})),
			style:      item.style,
			wndProc:    item.callback,
			instance:   app.instance,
			icon:       app.iconLarge,
			cursor:     cursor,
			background: item.background,
			className:  utf16Pointer(item.name),
			iconSmall:  app.iconSmall,
		}
		atom, _, callErr := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
		if atom == 0 {
			return fmt.Errorf("注册窗口类 %s 失败：%v", item.name, callErr)
		}
	}
	return nil
}

func createMainWindow() error {
	width := px(1040)
	height := px(700)
	screenWidth, _, _ := procGetSystemMetrics.Call(smCxScreen)
	screenHeight, _, _ := procGetSystemMetrics.Call(smCyScreen)
	x := (int32(screenWidth) - width) / 2
	y := (int32(screenHeight) - height) / 2
	app.main = createWindow(wsExAppWindow, mainClassName, "DataYao 光学发送", wsOverlappedWindow|wsClipChildren, x, y, width, height, 0, 0, app.instance)
	if app.main == 0 {
		return fmt.Errorf("创建主窗口失败")
	}
	procDragAcceptFiles.Call(app.main, 1)
	showWindow(app.main, swShow)
	procUpdateWindow.Call(app.main)
	return nil
}

func runMessageLoop() {
	var message msg
	for {
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func mainWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmCreate:
		app.main = hwnd
		createControls(hwnd)
		layoutControls(hwnd)
		if startupTestText != "" {
			updateMode(modeText)
			setWindowText(app.textEdit, startupTestText)
			startTransfer()
		} else if startupTestFile != "" {
			selectFile(startupTestFile)
			startTransfer()
		}
		return 0
	case wmSize:
		layoutControls(hwnd)
		return 0
	case wmGetMinMaxInfo:
		info := (*minMaxInfo)(unsafe.Pointer(lParam))
		info.minTrackSize.x = px(860)
		info.minTrackSize.y = px(590)
		return 0
	case wmCommand:
		handleCommand(lowWord(wParam), highWord(wParam))
		return 0
	case wmTimer:
		if wParam == frameTimerID {
			tickTransfer()
			return 0
		}
	case wmHScroll:
		if lParam == app.scaleTrack {
			app.qrScale = int(sendMessage(app.scaleTrack, tbmGetPos, 0, 0))
			setWindowText(app.scaleValue, fmt.Sprintf("%d%%", app.qrScale))
			invalidateWindow(app.qrWindow)
			invalidateWindow(app.fullWindow)
			return 0
		}
	case wmDrawItem:
		return drawOwnerButton((*drawItemStruct)(unsafe.Pointer(lParam)))
	case wmCtlColorStatic:
		return colorStatic(wParam, lParam)
	case wmCtlColorEdit:
		procSetBkColor.Call(wParam, rgb(255, 255, 255))
		procSetTextColor.Call(wParam, rgb(34, 37, 43))
		return app.brushSurface
	case wmDropFiles:
		handleDroppedFile(wParam)
		return 0
	case wmDestroy:
		stopTransfer(false)
		if app.fullWindow != 0 {
			procDestroyWindow.Call(app.fullWindow)
			app.fullWindow = 0
		}
		procPostQuitMessage.Call(0)
		return 0
	}
	return defaultWindowProc(hwnd, message, wParam, lParam)
}

func createControls(hwnd uintptr) {
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
	createCombo := func(id int) uintptr {
		handle := createWindow(0, "COMBOBOX", "", wsChild|wsVisible|wsTabStop|cbsDropDownList|wsVScroll, 0, 0, 10, 200, hwnd, uintptr(id), app.instance)
		sendMessage(handle, wmSetFont, app.font, 1)
		return handle
	}

	title := createLabel("发送", app.fontTitle)
	_ = title
	app.versionLabel = createLabel(fmt.Sprintf("DataYao %s · %s", version, buildTarget), app.font)
	app.modeFileButton = createButton(idModeFile, "文件")
	app.modeTextButton = createButton(idModeText, "文本")
	app.drop = createWindow(0, dropClassName, "", wsChild|wsVisible|wsTabStop, 0, 0, 10, 10, hwnd, 0, app.instance)
	procDragAcceptFiles.Call(app.drop, 1)
	app.textEdit = createWindow(wsExClientEdge, "EDIT", "", wsChild|wsTabStop|wsBorder|esLeft|esMultiline|esAutoVScroll|esWantReturn|esNoHideSel|wsVScroll, 0, 0, 10, 10, hwnd, uintptr(idTextEdit), app.instance)
	sendMessage(app.textEdit, wmSetFont, app.font, 1)
	sendMessage(app.textEdit, emSetLimitText, 4*1024*1024, 0)

	carrierLabel := createLabel("传输方式", app.font)
	blockLabel := createLabel("每帧字节", app.font)
	fpsLabel := createLabel("播放帧率", app.font)
	eccLabel := createLabel("二维码纠错", app.font)
	app.settingLabels = []uintptr{title, carrierLabel, blockLabel, fpsLabel, eccLabel}
	app.carrierCombo = createCombo(idCarrier)
	app.blockCombo = createCombo(idBlock)
	app.fpsCombo = createCombo(idFPS)
	app.eccCombo = createCombo(idECC)
	fillCombo(app.carrierCombo, []string{"黑白 QR", "彩色 QR", "声音"}, carrierQR)
	fillCombo(app.blockCombo, []string{"800", "1200", "1600", "2000", "2300"}, 1)
	fillCombo(app.fpsCombo, []string{"10 fps", "15 fps", "20 fps", "24 fps", "30 fps"}, 1)
	fillCombo(app.eccCombo, []string{"L · 快速", "M · 稳定"}, 0)
	app.rateLabel = createLabel("预计有效速度 15 KB/s", app.fontMedium)
	app.startButton = createButton(idStart, "开始发送")

	app.statusLabel = createLabel("等待选择文件", app.fontMedium)
	app.fullButton = createButton(idFull, "全屏")
	app.qrWindow = createWindow(0, qrClassName, "", wsChild|wsVisible, 0, 0, 10, 10, hwnd, 0, app.instance)
	app.scaleValue = createLabel("85%", app.fontMedium)
	scaleLabel := createLabel("二维码大小", app.font)
	app.settingLabels = append(app.settingLabels, scaleLabel)
	app.scaleTrack = createWindow(0, "msctls_trackbar32", "", wsChild|wsVisible|wsTabStop|tbsAutoTicks, 0, 0, 10, 10, hwnd, uintptr(idScale), app.instance)
	sendMessage(app.scaleTrack, tbmSetRange, 1, makeLong(45, 100))
	sendMessage(app.scaleTrack, tbmSetTicFreq, 5, 0)
	sendMessage(app.scaleTrack, tbmSetPos, 1, uintptr(app.qrScale))
	app.metricsLabel = createLabel("完全离线 · 与 DataYao Android / 鸿蒙 / Web 接收端兼容", app.font)

	updateMode(modeFile)
	updateCarrierControls()
	updateRateLabel()
}

func fillCombo(combo uintptr, values []string, selected int) {
	sendMessage(combo, cbResetContent, 0, 0)
	for _, value := range values {
		sendMessage(combo, cbAddString, 0, uintptr(unsafe.Pointer(utf16Pointer(value))))
	}
	sendMessage(combo, cbSetCurSel, uintptr(selected), 0)
}

func layoutControls(hwnd uintptr) {
	if len(app.settingLabels) < 6 {
		return
	}
	client := getClientRectangle(hwnd)
	width := client.right - client.left
	height := client.bottom - client.top
	margin := px(24)
	leftWidth := px(310)
	gap := px(26)
	controlHeight := px(38)
	labelHeight := px(24)

	moveWindow(app.settingLabels[0], margin, px(19), leftWidth, px(40))
	moveWindow(app.versionLabel, margin, px(55), leftWidth, labelHeight)
	buttonWidth := (leftWidth - px(8)) / 2
	moveWindow(app.modeFileButton, margin, px(88), buttonWidth, controlHeight)
	moveWindow(app.modeTextButton, margin+buttonWidth+px(8), px(88), buttonWidth, controlHeight)
	moveWindow(app.drop, margin, px(140), leftWidth, px(118))
	moveWindow(app.textEdit, margin, px(140), leftWidth, px(118))

	rowY := px(270)
	comboX := margin + px(116)
	comboWidth := leftWidth - px(116)
	for index := 0; index < 4; index++ {
		moveWindow(app.settingLabels[index+1], margin, rowY+int32(index)*px(48), px(108), controlHeight)
	}
	moveWindow(app.carrierCombo, comboX, rowY, comboWidth, px(220))
	moveWindow(app.blockCombo, comboX, rowY+px(48), comboWidth, px(220))
	moveWindow(app.fpsCombo, comboX, rowY+px(96), comboWidth, px(220))
	moveWindow(app.eccCombo, comboX, rowY+px(144), comboWidth, px(220))
	moveWindow(app.rateLabel, margin, rowY+px(194), leftWidth, labelHeight)
	moveWindow(app.startButton, margin, rowY+px(228), leftWidth, px(46))

	rightX := margin + leftWidth + gap
	rightWidth := width - rightX - margin
	moveWindow(app.statusLabel, rightX, px(20), rightWidth-px(78), px(38))
	moveWindow(app.fullButton, rightX+rightWidth-px(68), px(20), px(68), px(36))
	qrTop := px(68)
	qrBottomControls := px(102)
	qrHeight := height - qrTop - qrBottomControls
	if qrHeight < px(300) {
		qrHeight = px(300)
	}
	moveWindow(app.qrWindow, rightX, qrTop, rightWidth, qrHeight)
	scaleY := qrTop + qrHeight + px(12)
	moveWindow(app.settingLabels[5], rightX, scaleY, px(100), controlHeight)
	moveWindow(app.scaleTrack, rightX+px(100), scaleY, rightWidth-px(164), controlHeight)
	moveWindow(app.scaleValue, rightX+rightWidth-px(58), scaleY, px(58), controlHeight)
	moveWindow(app.metricsLabel, rightX, scaleY+px(40), rightWidth, labelHeight)
}

func handleCommand(id, notification uint16) {
	switch id {
	case idModeFile:
		if notification == bnClicked && !app.running {
			updateMode(modeFile)
		}
	case idModeText:
		if notification == bnClicked && !app.running {
			updateMode(modeText)
		}
	case idStart:
		if notification == bnClicked {
			if app.running {
				stopTransfer(true)
			} else {
				startTransfer()
			}
		}
	case idFull:
		if notification == bnClicked {
			openFullscreen()
		}
	case idCarrier:
		if notification == cbnSelChange && !app.running {
			carrierIndex := int(sendMessage(app.carrierCombo, cbGetCurSel, 0, 0))
			if carrierIndex >= carrierQR && carrierIndex <= carrierSound {
				app.carrier = carrierIndex
			}
			updateCarrierControls()
			updateRateLabel()
		}
	case idBlock, idFPS, idECC:
		if notification == cbnSelChange {
			readSettings()
			updateRateLabel()
		}
	}
}

func updateMode(mode int) {
	app.mode = mode
	if mode == modeFile {
		showWindow(app.drop, swShow)
		showWindow(app.textEdit, swHide)
		if app.filePath == "" {
			setStatus("等待选择文件", false)
		} else {
			setStatus("文件已就绪", false)
		}
	} else {
		showWindow(app.drop, swHide)
		showWindow(app.textEdit, swShow)
		setStatus("输入文本后即可发送", false)
	}
	invalidateWindow(app.modeFileButton)
	invalidateWindow(app.modeTextButton)
}

func readSettings() {
	blocks := []int{800, 1200, 1600, 2000, 2300}
	fpsValues := []int{10, 15, 20, 24, 30}
	carrierIndex := int(sendMessage(app.carrierCombo, cbGetCurSel, 0, 0))
	blockIndex := int(sendMessage(app.blockCombo, cbGetCurSel, 0, 0))
	fpsIndex := int(sendMessage(app.fpsCombo, cbGetCurSel, 0, 0))
	eccIndex := int(sendMessage(app.eccCombo, cbGetCurSel, 0, 0))
	if carrierIndex >= carrierQR && carrierIndex <= carrierSound {
		app.carrier = carrierIndex
	}
	if app.carrier == carrierSound {
		blocks = []int{64, 96, 128}
	}
	if blockIndex >= 0 && blockIndex < len(blocks) {
		app.blockSize = blocks[blockIndex]
	}
	if app.carrier == carrierSound {
		if fpsIndex == 1 {
			app.audioProfile = audioFast
		} else {
			app.audioProfile = audioStable
		}
	} else if fpsIndex >= 0 && fpsIndex < len(fpsValues) {
		app.fps = fpsValues[fpsIndex]
	}
	if eccIndex == 1 {
		app.ecc = qrcode.Medium
	} else {
		app.ecc = qrcode.Low
	}
}

func updateCarrierControls() {
	if app.carrier == carrierSound {
		app.blockSize = 64
		app.audioProfile = audioStable
		fillCombo(app.blockCombo, []string{"64", "96", "128"}, 0)
		setWindowText(app.settingLabels[3], "声音速度")
		setWindowText(app.settingLabels[4], "音频校验")
		fillCombo(app.fpsCombo, []string{"稳定", "快速"}, 0)
		fillCombo(app.eccCombo, []string{"CRC32"}, 0)
		enableWindow(app.fpsCombo, true)
		enableWindow(app.eccCombo, false)
		enableWindow(app.fullButton, false)
		enableWindow(app.scaleTrack, false)
	} else {
		app.blockSize = 1200
		app.fps = 15
		fillCombo(app.blockCombo, []string{"800", "1200", "1600", "2000", "2300"}, 1)
		setWindowText(app.settingLabels[3], "播放帧率")
		setWindowText(app.settingLabels[4], "二维码纠错")
		fillCombo(app.fpsCombo, []string{"10 fps", "15 fps", "20 fps", "24 fps", "30 fps"}, 1)
		fillCombo(app.eccCombo, []string{"L · 快速", "M · 稳定"}, 0)
		enableWindow(app.fpsCombo, true)
		enableWindow(app.eccCombo, true)
		enableWindow(app.fullButton, true)
		enableWindow(app.scaleTrack, true)
	}
	invalidateWindow(app.drop)
}

func updateRateLabel() {
	if app.carrier == carrierSound {
		duration := float64(audioFrameDurationMs(24+app.blockSize, app.audioProfile)) / 1000
		rate := float64(app.blockSize) / 1.2 / duration
		setWindowText(app.rateLabel, fmt.Sprintf("预计有效速度 %.0f B/s", rate))
		return
	}
	channels := 1.0
	if app.carrier == carrierColor {
		channels = 3
	}
	rate := float64(app.blockSize*app.fps) * channels / 1.2 / 1024
	setWindowText(app.rateLabel, fmt.Sprintf("预计有效速度 %.0f KB/s", rate))
}

func startTransfer() {
	readSettings()
	setStatus("正在准备数据…", false)
	procUpdateWindow.Call(app.main)

	var data []byte
	var name string
	var mimeType string
	isText := false
	if app.mode == modeFile {
		if app.filePath == "" {
			showTransferError("尚未选择文件", "请先点击文件区域选择文件，或把文件拖入窗口。")
			return
		}
		info, err := os.Stat(app.filePath)
		if err != nil {
			showTransferError("无法读取文件", fmt.Sprintf("文件信息读取失败：%v", err))
			return
		}
		if info.IsDir() {
			showTransferError("不能发送文件夹", "请选择单个文件；当前版本不打包文件夹。")
			return
		}
		if info.Size() == 0 {
			showTransferError("文件为空", "DataYao 不发送 0 字节文件。")
			return
		}
		if info.Size() > maxFileBytes {
			showTransferError("文件超过限制", fmt.Sprintf("当前文件为 %s，最大支持 64 MB。", formatBytes(info.Size())))
			return
		}
		var readErr error
		data, readErr = ioutil.ReadFile(app.filePath)
		if readErr != nil {
			showTransferError("无法读取文件", fmt.Sprintf("读取失败：%v", readErr))
			return
		}
		name = filepath.Base(app.filePath)
		mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
	} else {
		text := readWindowText(app.textEdit)
		if strings.TrimSpace(text) == "" {
			showTransferError("文本为空", "请输入要发送的文本。")
			return
		}
		data = []byte(text)
		if len(data) > maxFileBytes {
			showTransferError("文本超过限制", "UTF-8 文本编码后超过 64 MB。")
			return
		}
		name = "datayao-text.txt"
		mimeType = "text/plain;charset=utf-8"
		isText = true
	}
	if app.carrier == carrierSound && len(data) > 64*1024 {
		showTransferError("声音模式仅适合短数据", "声音传输速度约为每秒 8–12 字节，请将内容控制在 64 KB 内；较大文件请使用黑白或彩色二维码。")
		return
	}

	payload, err := packTransfer(name, mimeType, data, isText)
	if err != nil {
		showTransferError("无法准备传输", err.Error())
		return
	}
	blockCount := (len(payload.container) + app.blockSize - 1) / app.blockSize
	if blockCount > 0xffff {
		showTransferError("每帧容量不足", "源块数量超过 65,535。请提高“每帧字节”，然后重试。")
		return
	}
	sessionID := randomSessionID()
	app.payload = payload
	app.encoder = newFountainEncoder(payload.container, app.blockSize, sessionID)
	app.header = makeHeader(payload.container, app.blockSize, sessionID, byte(boolToInt(isText)))
	app.sequence = 0
	if err = renderFrame(app.sequence); err != nil {
		app.payload = nil
		app.encoder = nil
		showTransferError("二维码参数不兼容", fmt.Sprintf("每帧 %d 字节、纠错 %s 无法生成二维码：%v。请降低每帧字节或切换纠错级别。", app.blockSize, eccName(), err))
		return
	}
	if app.carrier == carrierColor {
		app.sequence += 3
	} else {
		app.sequence++
	}
	app.running = true
	setTransferControlsEnabled(false)
	setWindowText(app.startButton, "停止发送")
	invalidateWindow(app.startButton)
	interval := 1000 / app.fps
	if app.carrier == carrierSound {
		interval = audioFrameDurationMs(24+app.blockSize, app.audioProfile)
	}
	procSetTimer.Call(app.main, frameTimerID, uintptr(interval), 0)
	updateTransferStatus()
}

func tickTransfer() {
	if !app.running || app.encoder == nil {
		return
	}
	if err := renderFrame(app.sequence); err != nil {
		stopTransfer(false)
		showTransferError("二维码生成失败", fmt.Sprintf("序列 %d：%v", app.sequence, err))
		return
	}
	if app.carrier == carrierColor {
		app.sequence += 3
	} else {
		app.sequence++
	}
	if app.sequence%5 == 0 {
		updateTransferStatus()
	}
}

func renderFrame(sequence uint32) error {
	header := app.header
	header.sequence = sequence
	if app.carrier == carrierSound {
		frame, err := packFrame(header, app.encoder.encode(sequence))
		if err != nil {
			return err
		}
		app.audioWav = encodeAudioWAV(frame, app.audioProfile)
		playAudioWAV(app.audioWav)
		app.qrPixels = nil
		app.qrModules = 0
		app.qrVersion = 0
		invalidateWindow(app.qrWindow)
		return nil
	}
	count := 1
	if app.carrier == carrierColor {
		count = 3
	}
	frames := make([][]byte, count)
	for index := 0; index < count; index++ {
		frame, err := packFrame(frameHeader{flags: app.header.flags, sessionID: app.header.sessionID, sequence: sequence + uint32(index), blockCount: app.header.blockCount, blockSize: app.header.blockSize, totalLength: app.header.totalLength, payloadCRC: app.header.payloadCRC}, app.encoder.encode(sequence+uint32(index)))
		if err != nil {
			return err
		}
		frames[index] = frame
	}
	codes := make([][][]bool, count)
	size := 0
	version := 0
	for index, frame := range frames {
		code, err := qrcode.New(string(frame), app.ecc)
		if err != nil {
			return err
		}
		codes[index] = code.Bitmap()
		if index == 0 {
			size = len(codes[index])
			version = code.VersionNumber
		} else if len(codes[index]) != size {
			return fmt.Errorf("彩色二维码通道版本不一致")
		}
	}
	pixels := make([]uint32, size*size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			red, green, blue := byte(240), byte(240), byte(240)
			if codes[0][y][x] {
				red = 16
			}
			if count > 1 && codes[1][y][x] {
				green = 16
			}
			if count > 2 && codes[2][y][x] {
				blue = 16
			}
			pixels[y*size+x] = uint32(blue) | uint32(green)<<8 | uint32(red)<<16
		}
	}
	app.qrPixels = pixels
	app.qrModules = size
	app.qrVersion = version
	invalidateWindow(app.qrWindow)
	if app.fullWindow != 0 {
		invalidateWindow(app.fullWindow)
	}
	return nil
}

func stopTransfer(showStopped bool) {
	if app.main != 0 {
		procKillTimer.Call(app.main, frameTimerID)
	}
	stopAudio()
	wasRunning := app.running
	app.running = false
	app.encoder = nil
	app.payload = nil
	app.qrPixels = nil
	app.qrModules = 0
	app.qrVersion = 0
	app.audioWav = nil
	if app.startButton != 0 {
		setWindowText(app.startButton, "开始发送")
		setTransferControlsEnabled(true)
		updateCarrierControls()
		invalidateWindow(app.startButton)
	}
	if showStopped && wasRunning {
		setStatus("发送已停止", false)
	}
	invalidateWindow(app.qrWindow)
	if app.fullWindow != 0 {
		closeFullscreen()
	}
}

func playAudioWAV(wav []byte) {
	if len(wav) == 0 {
		return
	}
	procPlaySoundW.Call(uintptr(unsafe.Pointer(&wav[0])), sndMemory|sndAsync)
}

func stopAudio() {
	procPlaySoundW.Call(0, sndPurge)
}

func setTransferControlsEnabled(enabled bool) {
	controls := []uintptr{app.modeFileButton, app.modeTextButton, app.drop, app.textEdit, app.carrierCombo, app.blockCombo, app.fpsCombo, app.eccCombo}
	for _, control := range controls {
		enableWindow(control, enabled)
	}
}

func updateTransferStatus() {
	carrierStatus := fmt.Sprintf("QR V%d-%s", app.qrVersion, eccName())
	if app.carrier == carrierColor {
		carrierStatus = fmt.Sprintf("彩色 QR V%d-%s · 3 通道", app.qrVersion, eccName())
	} else if app.carrier == carrierSound {
		carrierStatus = "声音 DTMF"
	}
	setStatus(fmt.Sprintf("正在发送 · 帧 %s · %s", formatUint(uint64(app.sequence)), carrierStatus), false)
	if app.payload != nil {
		name := app.payload.fileName
		setWindowText(app.metricsLabel, fmt.Sprintf("%s · %s → %s · %s 个源块", name, formatBytes(int64(app.payload.originalLen)), formatBytes(int64(len(app.payload.container))), formatUint(uint64(len(app.encoder.blocks)))))
	}
}

func randomSessionID() uint32 {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err == nil {
		value := binary.LittleEndian.Uint32(buffer)
		if value != 0 {
			return value
		}
	}
	return uint32(time.Now().UnixNano()) | 1
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func eccName() string {
	if app.ecc == qrcode.Medium {
		return "M"
	}
	return "L"
}

func readWindowText(hwnd uintptr) string {
	length, _, _ := procGetWindowTextLengthW.Call(hwnd)
	buffer := make([]uint16, int(length)+1)
	if len(buffer) > 0 {
		procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	}
	return syscall.UTF16ToString(buffer)
}

func selectFile(path string) {
	if app.running {
		showTransferError("发送正在进行", "请先停止发送，再更换文件。")
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		showTransferError("无法选择文件", fmt.Sprintf("文件信息读取失败：%v", err))
		return
	}
	if info.IsDir() {
		showTransferError("不能发送文件夹", "请拖入或选择单个文件。")
		return
	}
	if info.Size() > maxFileBytes {
		showTransferError("文件超过限制", fmt.Sprintf("当前文件为 %s，最大支持 64 MB。", formatBytes(info.Size())))
		return
	}
	app.filePath = path
	app.fileSize = info.Size()
	updateMode(modeFile)
	setStatus("文件已就绪", false)
	invalidateWindow(app.drop)
}

func chooseFile() {
	if app.running {
		showTransferError("发送正在进行", "请先停止发送，再更换文件。")
		return
	}
	buffer := make([]uint16, 32768)
	filter := syscall.StringToUTF16("所有文件 (*.*)\x00*.*\x00\x00")
	title := utf16Pointer("选择要通过二维码发送的文件")
	dialog := openFileName{
		structSize:  uint32(unsafe.Sizeof(openFileName{})),
		owner:       app.main,
		filter:      &filter[0],
		filterIndex: 1,
		file:        &buffer[0],
		maxFile:     uint32(len(buffer)),
		title:       title,
		flags:       ofNExplorer | ofNFileMustExist | ofNPathMustExist | ofNNoChangeDir,
	}
	result, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&dialog)))
	if result != 0 {
		selectFile(syscall.UTF16ToString(buffer))
	}
}

func handleDroppedFile(drop uintptr) {
	defer procDragFinish.Call(drop)
	if app.running {
		showTransferError("发送正在进行", "请先停止发送，再拖入新文件。")
		return
	}
	length, _, _ := procDragQueryFileW.Call(drop, 0, 0, 0)
	if length == 0 {
		showTransferError("未读取到文件", "拖放内容不包含可读取的文件路径。")
		return
	}
	buffer := make([]uint16, int(length)+1)
	procDragQueryFileW.Call(drop, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	selectFile(syscall.UTF16ToString(buffer))
}

func setStatus(value string, isError bool) {
	app.statusError = isError
	setWindowText(app.statusLabel, value)
	invalidateWindow(app.statusLabel)
}

func showTransferError(title, detail string) {
	setStatus(title+" · "+detail, true)
	messageBox(app.main, title, detail)
}

func messageBox(owner uintptr, title, detail string) {
	procMessageBoxW.Call(owner, uintptr(unsafe.Pointer(utf16Pointer(detail))), uintptr(unsafe.Pointer(utf16Pointer(title))), mbOK|mbIconError)
}

func drawOwnerButton(item *drawItemStruct) uintptr {
	if item == nil {
		return 0
	}
	activeTab := (item.hwndItem == app.modeFileButton && app.mode == modeFile) || (item.hwndItem == app.modeTextButton && app.mode == modeText)
	isPrimary := item.hwndItem == app.startButton
	background := app.brushSurface
	textColor := rgb(34, 37, 43)
	if activeTab || isPrimary {
		background = app.brushAccent
		textColor = rgb(255, 255, 255)
	}
	if isPrimary && app.running {
		background = app.brushDanger
	}
	if item.itemState&odSelected != 0 {
		background = app.brushAccentPressed
	}
	if item.itemState&odDisabled != 0 {
		background = app.brushStage
		textColor = rgb(132, 137, 145)
	}
	procFillRect.Call(item.hdc, uintptr(unsafe.Pointer(&item.itemRect)), background)
	if !activeTab && !isPrimary {
		procFrameRect.Call(item.hdc, uintptr(unsafe.Pointer(&item.itemRect)), app.brushMutedBorder)
	}
	procSetBkMode.Call(item.hdc, transparent)
	procSetTextColor.Call(item.hdc, textColor)
	procSelectObject.Call(item.hdc, app.fontMedium)
	text := readWindowText(item.hwndItem)
	area := item.itemRect
	drawText(item.hdc, text, &area, dtCenter|dtVCenter|dtSingleLine|dtNoPrefix)
	if item.itemState&odFocus != 0 {
		focus := item.itemRect
		focus.left += px(3)
		focus.top += px(3)
		focus.right -= px(3)
		focus.bottom -= px(3)
		procFrameRect.Call(item.hdc, uintptr(unsafe.Pointer(&focus)), app.brushMutedBorder)
	}
	return 1
}

func colorStatic(hdc, control uintptr) uintptr {
	procSetBkMode.Call(hdc, transparent)
	color := rgb(82, 87, 95)
	if control == app.statusLabel {
		if app.statusError {
			color = rgb(194, 57, 52)
		} else {
			color = rgb(34, 37, 43)
		}
	} else if control == app.rateLabel {
		color = rgb(0, 102, 204)
	}
	procSetTextColor.Call(hdc, color)
	return app.brushBackground
}

func qrWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmPaint:
		paintQRWindow(hwnd)
		return 0
	case wmEraseBkGnd:
		return 1
	case wmLButtonDblClk:
		if hwnd == app.fullWindow {
			closeFullscreen()
		} else {
			openFullscreen()
		}
		return 0
	case wmKeyDown:
		if wParam == vkEscape && hwnd == app.fullWindow {
			closeFullscreen()
			return 0
		}
	case wmClose:
		if hwnd == app.fullWindow {
			closeFullscreen()
			return 0
		}
	}
	return defaultWindowProc(hwnd, message, wParam, lParam)
}

func paintQRWindow(hwnd uintptr) {
	var paint paintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return
	}
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	client := getClientRectangle(hwnd)
	procFillRect.Call(hdc, uintptr(unsafe.Pointer(&client)), app.brushStage)
	width := client.right - client.left
	height := client.bottom - client.top
	if len(app.qrPixels) == 0 || app.qrModules == 0 {
		iconSize := width / 7
		if height/4 < iconSize {
			iconSize = height / 4
		}
		if iconSize < px(84) {
			iconSize = px(84)
		}
		if iconSize > px(160) {
			iconSize = px(160)
		}
		iconX := (width - iconSize) / 2
		iconY := height/2 - iconSize/2 - px(42)
		if app.iconLarge != 0 {
			procDrawIconEx.Call(hdc, uintptr(iconX), uintptr(iconY), app.iconLarge, uintptr(iconSize), uintptr(iconSize), 0, 0, 0x0003)
		}
		procSetBkMode.Call(hdc, transparent)
		procSetTextColor.Call(hdc, rgb(34, 37, 43))
		procSelectObject.Call(hdc, app.fontTitle)
		brandTop := iconY + iconSize + px(10)
		brand := rect{left: 0, top: brandTop, right: width, bottom: brandTop + px(42)}
		drawText(hdc, "DataYao", &brand, dtCenter|dtVCenter|dtSingleLine|dtNoPrefix)
		procSelectObject.Call(hdc, app.font)
		procSetTextColor.Call(hdc, rgb(105, 111, 121))
		stateText := "等待开始"
		if app.running && app.carrier == carrierSound {
			stateText = "正在播放 DataYao 声音"
		}
		state := rect{left: 0, top: brand.bottom, right: width, bottom: brand.bottom + px(34)}
		drawText(hdc, stateText, &state, dtCenter|dtVCenter|dtSingleLine|dtNoPrefix)
		return
	}
	available := width
	if height < available {
		available = height
	}
	available -= px(30)
	target := available * int32(app.qrScale) / 100
	modulePixels := target / int32(app.qrModules)
	if modulePixels < 1 {
		modulePixels = 1
	}
	drawSize := modulePixels * int32(app.qrModules)
	x := (width - drawSize) / 2
	y := (height - drawSize) / 2
	info := bitmapInfo{}
	info.header.size = uint32(unsafe.Sizeof(bitmapInfoHeader{}))
	info.header.width = int32(app.qrModules)
	info.header.height = -int32(app.qrModules)
	info.header.planes = 1
	info.header.bitCount = 32
	info.header.compression = biRGB
	procSetStretchBltMode.Call(hdc, colorOnColor)
	procStretchDIBits.Call(
		hdc,
		uintptr(x), uintptr(y), uintptr(drawSize), uintptr(drawSize),
		0, 0, uintptr(app.qrModules), uintptr(app.qrModules),
		uintptr(unsafe.Pointer(&app.qrPixels[0])),
		uintptr(unsafe.Pointer(&info)),
		dibRGBColors, srccopy,
	)
}

func dropWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmPaint:
		paintDropWindow(hwnd)
		return 0
	case wmEraseBkGnd:
		return 1
	case wmLButtonUp:
		chooseFile()
		return 0
	case wmSetFocus:
		invalidateWindow(hwnd)
		return 0
	case wmDropFiles:
		handleDroppedFile(wParam)
		return 0
	}
	return defaultWindowProc(hwnd, message, wParam, lParam)
}

func paintDropWindow(hwnd uintptr) {
	var paint paintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	if hdc == 0 {
		return
	}
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&paint)))
	client := getClientRectangle(hwnd)
	procFillRect.Call(hdc, uintptr(unsafe.Pointer(&client)), app.brushSurface)
	procFrameRect.Call(hdc, uintptr(unsafe.Pointer(&client)), app.brushMutedBorder)
	procSetBkMode.Call(hdc, transparent)
	procSelectObject.Call(hdc, app.fontMedium)
	procSetTextColor.Call(hdc, rgb(34, 37, 43))
	mainText := "选择文件或拖入此区域"
	subText := "最大 64 MB"
	if app.carrier == carrierSound {
		subText = "最大 64 KB"
	}
	if app.filePath != "" {
		mainText = filepath.Base(app.filePath)
		subText = formatBytes(app.fileSize)
	}
	top := rect{left: px(18), top: px(25), right: client.right - px(18), bottom: px(65)}
	drawText(hdc, mainText, &top, dtCenter|dtVCenter|dtSingleLine|dtEndEllipsis|dtNoPrefix)
	procSelectObject.Call(hdc, app.font)
	procSetTextColor.Call(hdc, rgb(105, 111, 121))
	bottom := rect{left: px(18), top: px(68), right: client.right - px(18), bottom: px(98)}
	drawText(hdc, subText, &bottom, dtCenter|dtVCenter|dtSingleLine|dtNoPrefix)
}

func openFullscreen() {
	if app.fullWindow != 0 {
		return
	}
	monitor, _, _ := procMonitorFromWindow.Call(app.main, monitorDefaultToNearest)
	info := monitorInfo{size: uint32(unsafe.Sizeof(monitorInfo{}))}
	if monitor == 0 {
		return
	}
	result, _, _ := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&info)))
	if result == 0 {
		return
	}
	area := info.monitor
	app.fullWindow = createWindow(wsExTopmost|wsExAppWindow, qrClassName, "DataYao", wsPopup|wsVisible, area.left, area.top, area.right-area.left, area.bottom-area.top, 0, 0, app.instance)
	if app.fullWindow == 0 {
		showTransferError("无法进入全屏", "Windows 未能创建全屏二维码窗口。")
		return
	}
	showWindow(app.main, swHide)
	showWindow(app.fullWindow, swShow)
	procSetForegroundWindow.Call(app.fullWindow)
	procSetFocus.Call(app.fullWindow)
}

func closeFullscreen() {
	if app.fullWindow == 0 {
		return
	}
	window := app.fullWindow
	app.fullWindow = 0
	procDestroyWindow.Call(window)
	showWindow(app.main, swShow)
	procSetForegroundWindow.Call(app.main)
}

func formatBytes(value int64) string {
	if value < 1024 {
		return fmt.Sprintf("%d B", value)
	}
	if value < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(value)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(value)/1024/1024)
}

func formatUint(value uint64) string {
	raw := fmt.Sprintf("%d", value)
	if len(raw) <= 3 {
		return raw
	}
	first := len(raw) % 3
	if first == 0 {
		first = 3
	}
	var output strings.Builder
	output.WriteString(raw[:first])
	for index := first; index < len(raw); index += 3 {
		output.WriteByte(',')
		output.WriteString(raw[index : index+3])
	}
	return output.String()
}

func writeSelfTestQR(path string) error {
	source := []byte("DataYao native optical self-test")
	payload, err := packTransfer("self-test.txt", "text/plain;charset=utf-8", source, true)
	if err != nil {
		return err
	}
	const blockSize = 800
	const sessionID uint32 = 0x31415926
	encoder := newFountainEncoder(payload.container, blockSize, sessionID)
	header := makeHeader(payload.container, blockSize, sessionID, 1)
	frame, err := packFrame(header, encoder.encode(0))
	if err != nil {
		return err
	}
	code, err := qrcode.New(string(frame), qrcode.Low)
	if err != nil {
		return err
	}
	png, err := code.PNG(1024)
	if err != nil {
		return err
	}
	return ioutil.WriteFile(path, png, 0644)
}
