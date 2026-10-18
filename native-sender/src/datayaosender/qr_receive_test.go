package main

import (
	"bytes"
	"image"
	"testing"

	qrcode "github.com/skip2/go-qrcode"
)

// decodeQrBitmap renders a DataYao frame the same way the sender UI does
// (module grid from skip2/go-qrcode) and feeds it to the vendored pure-Go
// decoder used by the native receiver.
func decodeQrBitmap(t *testing.T, frame []byte, sequence uint32) []byte {
	t.Helper()
	code, err := qrcode.New(string(frame), qrcode.Low)
	if err != nil {
		t.Fatalf("frame %d encode QR: %v", sequence, err)
	}
	bitmap := code.Bitmap()
	size := len(bitmap)
	const scale = 4
	img := image.NewGray(image.Rect(0, 0, size*scale, size*scale))
	for row := 0; row < size; row++ {
		for column := 0; column < size; column++ {
			value := uint8(255)
			if bitmap[row][column] {
				value = 0
			}
			for dy := 0; dy < scale; dy++ {
				for dx := 0; dx < scale; dx++ {
					img.Pix[(row*scale+dy)*size*scale+column*scale+dx] = value
				}
			}
		}
	}
	result, err := decodeQrGray(img)
	if err != nil {
		t.Fatalf("frame %d decode QR: %v", sequence, err)
	}
	raw := rawBytesFromResult(result)
	if len(raw) == 0 {
		t.Fatal("decoder returned no raw bytes")
	}
	return raw
}

func TestNativeReceiverDecodesSenderFrames(t *testing.T) {
	source := []byte("DataYao native sender-to-receiver round trip payload")
	payload, err := packTransfer("roundtrip.bin", "application/octet-stream", source, false)
	if err != nil {
		t.Fatal(err)
	}
	const sessionID uint32 = 0x2a2a2a2a
	const blockSize = 64
	encoder := newFountainEncoder(payload.container, blockSize, sessionID)
	header := makeHeader(payload.container, blockSize, sessionID, 0)
	decoder := newFountainDecoder(len(encoder.blocks), blockSize, sessionID, len(payload.container))

	for sequence := uint32(0); sequence < uint32(len(encoder.blocks))+3; sequence++ {
		block := encoder.encode(sequence)
		frame, err := packFrame(frameHeader{
			flags:       header.flags,
			sessionID:   header.sessionID,
			sequence:    sequence,
			blockCount:  header.blockCount,
			blockSize:   header.blockSize,
			totalLength: header.totalLength,
			payloadCRC:  header.payloadCRC,
		}, block)
		if err != nil {
			t.Fatal(err)
		}
		raw := decodeQrBitmap(t, frame, sequence)
		parsed, parsedBlock, err := parseFrame(raw)
		if err != nil {
			t.Fatalf("frame %d did not survive the QR round trip: %v", sequence, err)
		}
		if parsed.sequence != sequence || parsed.blockSize != blockSize {
			t.Fatalf("frame %d header mismatch: %+v", sequence, parsed)
		}
		if !bytes.Equal(parsedBlock, block) {
			t.Fatalf("frame %d block bytes differ after round trip", sequence)
		}
		if !decoder.complete() {
			decoder.add(sequence, parsedBlock)
		}
	}
	if !decoder.complete() {
		t.Fatalf("decoder did not complete: solved %d of %d", decoder.solvedCount, decoder.blockCount)
	}
	unpacked, err := unpackTransfer(decoder.assemble())
	if err != nil {
		t.Fatal(err)
	}
	if unpacked.fileName != "roundtrip.bin" || !bytes.Equal(unpacked.bytes, source) {
		t.Fatalf("unexpected round trip result: %+v", unpacked)
	}
}
