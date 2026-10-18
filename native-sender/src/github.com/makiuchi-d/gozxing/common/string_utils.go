package common

// DataYao build note: text transcoding helpers were removed together with the
// x/text dependency; the QR decoder emits raw bytes and the parser appends
// them verbatim.

const (
	StringUtils_ASSUME_SHIFT_JIS = false
	StringUtils_SHIFT_JIS        = "SJIS"
	StringUtils_GB2312           = "GB2312"
)
