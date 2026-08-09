package main

import (
	"testing"

	qrcode "github.com/skip2/go-qrcode"
)

func testQRFrame(blockSize int) []byte {
	frame := make([]byte, frameHeaderSize+blockSize)
	for index := range frame {
		frame[index] = byte((index*131 + 17) & 0xff)
	}
	frame[0] = 'D'
	frame[1] = 'Y'
	frame[2] = protocolVersion
	return frame
}

func TestQRSettingCapacity(t *testing.T) {
	for _, blockSize := range []int{800, 1200, 1600, 2000, 2300} {
		for _, level := range []qrcode.RecoveryLevel{qrcode.Low, qrcode.Medium} {
			code, err := qrcode.New(string(testQRFrame(blockSize)), level)
			if err != nil {
				t.Fatalf("block size %d and recovery level %d failed: %v", blockSize, level, err)
			}
			if len(code.Bitmap()) == 0 {
				t.Fatalf("block size %d produced an empty QR bitmap", blockSize)
			}
		}
	}
}

func BenchmarkQRFrame1200Low(b *testing.B) {
	frame := testQRFrame(1200)
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		code, err := qrcode.New(string(frame), qrcode.Low)
		if err != nil {
			b.Fatal(err)
		}
		_ = code.Bitmap()
	}
}
