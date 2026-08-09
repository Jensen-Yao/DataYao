package main

import (
	"syscall"
	"unsafe"
)

type point struct {
	x int32
	y int32
}

type rect struct {
	left   int32
	top    int32
	right  int32
	bottom int32
}

type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
	private uint32
}

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSmall  uintptr
}

type paintStruct struct {
	hdc       uintptr
	erase     int32
	paint     rect
	restore   int32
	incUpdate int32
	reserved  [32]byte
}

type drawItemStruct struct {
	ctlType    uint32
	ctlID      uint32
	itemID     uint32
	itemAction uint32
	itemState  uint32
	hwndItem   uintptr
	hdc        uintptr
	itemRect   rect
	itemData   uintptr
}

type minMaxInfo struct {
	reserved     point
	maxSize      point
	maxPosition  point
	minTrackSize point
	maxTrackSize point
}

type openFileName struct {
	structSize       uint32
	owner            uintptr
	instance         uintptr
	filter           *uint16
	customFilter     *uint16
	maxCustomFilter  uint32
	filterIndex      uint32
	file             *uint16
	maxFile          uint32
	fileTitle        *uint16
	maxFileTitle     uint32
	initialDirectory *uint16
	title            *uint16
	flags            uint32
	fileOffset       uint16
	fileExtension    uint16
	defaultExtension *uint16
	customData       uintptr
	hook             uintptr
	templateName     *uint16
	reserved         uintptr
	reserved2        uint32
	flagsEx          uint32
}

type bitmapInfoHeader struct {
	size            uint32
	width           int32
	height          int32
	planes          uint16
	bitCount        uint16
	compression     uint32
	sizeImage       uint32
	xPixelsPerM     int32
	yPixelsPerM     int32
	colorsUsed      uint32
	colorsImportant uint32
}

type bitmapInfo struct {
	header bitmapInfoHeader
	colors [1]uint32
}

type monitorInfo struct {
	size    uint32
	monitor rect
	work    rect
	flags   uint32
}

type initCommonControlsEx struct {
	size uint32
	icc  uint32
}

const (
	csDoubleClicks = 0x0008
	csHRedraw      = 0x0002
	csVRedraw      = 0x0001

	wsOverlappedWindow = 0x00cf0000
	wsClipChildren     = 0x02000000
	wsPopup            = 0x80000000
	wsChild            = 0x40000000
	wsVisible          = 0x10000000
	wsTabStop          = 0x00010000
	wsVScroll          = 0x00200000
	wsBorder           = 0x00800000

	wsExAppWindow  = 0x00040000
	wsExTopmost    = 0x00000008
	wsExClientEdge = 0x00000200

	bsOwnerDraw = 0x0000000b

	ssLeft        = 0x00000000
	ssCenter      = 0x00000001
	ssCenterImage = 0x00000200

	esLeft        = 0x0000
	esMultiline   = 0x0004
	esAutoVScroll = 0x0040
	esWantReturn  = 0x1000
	esNoHideSel   = 0x0100

	cbsDropDownList = 0x0003

	tbsAutoTicks = 0x0001

	swHide = 0
	swShow = 5

	wmCreate         = 0x0001
	wmDestroy        = 0x0002
	wmSize           = 0x0005
	wmSetFocus       = 0x0007
	wmPaint          = 0x000f
	wmClose          = 0x0010
	wmEraseBkGnd     = 0x0014
	wmGetMinMaxInfo  = 0x0024
	wmDrawItem       = 0x002b
	wmCommand        = 0x0111
	wmTimer          = 0x0113
	wmHScroll        = 0x0114
	wmCtlColorEdit   = 0x0133
	wmCtlColorStatic = 0x0138
	wmKeyDown        = 0x0100
	wmLButtonUp      = 0x0202
	wmLButtonDblClk  = 0x0203
	wmDropFiles      = 0x0233
	wmSetFont        = 0x0030

	wmUser = 0x0400

	emSetLimitText = 0x00c5

	cbAddString = 0x0143
	cbGetCurSel = 0x0147
	cbSetCurSel = 0x014e

	tbmGetPos     = wmUser
	tbmSetPos     = wmUser + 5
	tbmSetRange   = wmUser + 6
	tbmSetTicFreq = wmUser + 20

	bnClicked    = 0
	cbnSelChange = 1

	odSelected = 0x0001
	odDisabled = 0x0004
	odFocus    = 0x0010

	dtLeft        = 0x0000
	dtCenter      = 0x0001
	dtRight       = 0x0002
	dtVCenter     = 0x0004
	dtWordBreak   = 0x0010
	dtSingleLine  = 0x0020
	dtEndEllipsis = 0x8000
	dtNoPrefix    = 0x0800

	transparent = 1

	dibRGBColors = 0
	srccopy      = 0x00cc0020
	colorOnColor = 3
	biRGB        = 0

	ofNPathMustExist = 0x00000800
	ofNFileMustExist = 0x00001000
	ofNExplorer      = 0x00080000
	ofNNoChangeDir   = 0x00000008

	mbOK        = 0x00000000
	mbIconError = 0x00000010

	idcArrow       = 32512
	idiApplication = 32512

	smCxScreen = 0
	smCyScreen = 1

	monitorDefaultToNearest = 2

	logPixelsX = 88

	iccBarClasses = 0x00000004

	vkEscape = 0x1b
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	comdlg32 = syscall.NewLazyDLL("comdlg32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")

	procRegisterClassExW     = user32.NewProc("RegisterClassExW")
	procCreateWindowExW      = user32.NewProc("CreateWindowExW")
	procDefWindowProcW       = user32.NewProc("DefWindowProcW")
	procShowWindow           = user32.NewProc("ShowWindow")
	procUpdateWindow         = user32.NewProc("UpdateWindow")
	procGetMessageW          = user32.NewProc("GetMessageW")
	procTranslateMessage     = user32.NewProc("TranslateMessage")
	procDispatchMessageW     = user32.NewProc("DispatchMessageW")
	procPostQuitMessage      = user32.NewProc("PostQuitMessage")
	procSendMessageW         = user32.NewProc("SendMessageW")
	procSetWindowTextW       = user32.NewProc("SetWindowTextW")
	procGetWindowTextW       = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW = user32.NewProc("GetWindowTextLengthW")
	procMoveWindow           = user32.NewProc("MoveWindow")
	procEnableWindow         = user32.NewProc("EnableWindow")
	procInvalidateRect       = user32.NewProc("InvalidateRect")
	procBeginPaint           = user32.NewProc("BeginPaint")
	procEndPaint             = user32.NewProc("EndPaint")
	procGetClientRect        = user32.NewProc("GetClientRect")
	procFillRect             = user32.NewProc("FillRect")
	procFrameRect            = user32.NewProc("FrameRect")
	procDrawTextW            = user32.NewProc("DrawTextW")
	procSetTimer             = user32.NewProc("SetTimer")
	procKillTimer            = user32.NewProc("KillTimer")
	procMessageBoxW          = user32.NewProc("MessageBoxW")
	procLoadCursorW          = user32.NewProc("LoadCursorW")
	procLoadIconW            = user32.NewProc("LoadIconW")
	procSetFocus             = user32.NewProc("SetFocus")
	procSetForegroundWindow  = user32.NewProc("SetForegroundWindow")
	procDestroyWindow        = user32.NewProc("DestroyWindow")
	procDestroyIcon          = user32.NewProc("DestroyIcon")
	procDrawIconEx           = user32.NewProc("DrawIconEx")
	procPrivateExtractIconsW = user32.NewProc("PrivateExtractIconsW")
	procGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	procMonitorFromWindow    = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW      = user32.NewProc("GetMonitorInfoW")
	procGetDC                = user32.NewProc("GetDC")
	procReleaseDC            = user32.NewProc("ReleaseDC")
	procSetProcessDPIAware   = user32.NewProc("SetProcessDPIAware")
	procIsProcessDPIAware    = user32.NewProc("IsProcessDPIAware")

	procCreateSolidBrush  = gdi32.NewProc("CreateSolidBrush")
	procDeleteObject      = gdi32.NewProc("DeleteObject")
	procSetTextColor      = gdi32.NewProc("SetTextColor")
	procSetBkMode         = gdi32.NewProc("SetBkMode")
	procSetBkColor        = gdi32.NewProc("SetBkColor")
	procSelectObject      = gdi32.NewProc("SelectObject")
	procCreateFontW       = gdi32.NewProc("CreateFontW")
	procStretchDIBits     = gdi32.NewProc("StretchDIBits")
	procSetStretchBltMode = gdi32.NewProc("SetStretchBltMode")
	procGetDeviceCaps     = gdi32.NewProc("GetDeviceCaps")

	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")

	procDragAcceptFiles = shell32.NewProc("DragAcceptFiles")
	procDragQueryFileW  = shell32.NewProc("DragQueryFileW")
	procDragFinish      = shell32.NewProc("DragFinish")
	procExtractIconExW  = shell32.NewProc("ExtractIconExW")

	procGetOpenFileNameW     = comdlg32.NewProc("GetOpenFileNameW")
	procInitCommonControlsEx = comctl32.NewProc("InitCommonControlsEx")
)

func rgb(red, green, blue byte) uintptr {
	return uintptr(red) | uintptr(green)<<8 | uintptr(blue)<<16
}

func utf16Pointer(value string) *uint16 {
	pointer, _ := syscall.UTF16PtrFromString(value)
	return pointer
}

func lowWord(value uintptr) uint16 {
	return uint16(value & 0xffff)
}

func highWord(value uintptr) uint16 {
	return uint16((value >> 16) & 0xffff)
}

func makeLong(low, high uint16) uintptr {
	return uintptr(uint32(low) | uint32(high)<<16)
}

func createWindow(exStyle uintptr, className, title string, style uintptr, x, y, width, height int32, parent, menu, instance uintptr) uintptr {
	result, _, _ := procCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(utf16Pointer(className))),
		uintptr(unsafe.Pointer(utf16Pointer(title))),
		style,
		uintptr(x), uintptr(y), uintptr(width), uintptr(height),
		parent, menu, instance, 0,
	)
	return result
}

func sendMessage(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	result, _, _ := procSendMessageW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}

func setWindowText(hwnd uintptr, value string) {
	procSetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(utf16Pointer(value))))
}

func moveWindow(hwnd uintptr, x, y, width, height int32) {
	procMoveWindow.Call(hwnd, uintptr(x), uintptr(y), uintptr(width), uintptr(height), 1)
}

func showWindow(hwnd uintptr, command int) {
	procShowWindow.Call(hwnd, uintptr(command))
}

func enableWindow(hwnd uintptr, enabled bool) {
	value := uintptr(0)
	if enabled {
		value = 1
	}
	procEnableWindow.Call(hwnd, value)
}

func invalidateWindow(hwnd uintptr) {
	procInvalidateRect.Call(hwnd, 0, 0)
}

func getClientRectangle(hwnd uintptr) rect {
	var result rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&result)))
	return result
}

func defaultWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}

func createBrush(color uintptr) uintptr {
	result, _, _ := procCreateSolidBrush.Call(color)
	return result
}

func deleteObject(handle uintptr) {
	if handle != 0 {
		procDeleteObject.Call(handle)
	}
}

func drawText(hdc uintptr, value string, area *rect, flags uintptr) {
	text := syscall.StringToUTF16(value)
	if len(text) == 0 {
		return
	}
	procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1), uintptr(unsafe.Pointer(area)), flags)
}
