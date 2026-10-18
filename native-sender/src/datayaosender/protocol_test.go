package main

import (
	"encoding/binary"
	"encoding/hex"
	"testing"
)

const fixtureContainerHex = "445943310102080018001c00000022a2a5b3fee3b2fcea7734a98d065b42a2c6ca5d28b0ef288c3a7c62ba3dd5af6e6f74652e747874746578742f706c61696e3b636861727365743d7574662d384461746159616f206e617469766520636f6d7061746962696c697479"

var fixtureFrameHex = []string{
	"445901012659413100000000020040006a00000019b507117f3a2b5073716d74257568662d3866c3d1d2a782dddc841640c0fb637b21cdabba3c5cd98d41e053081bba3dd5af6e6f74652e747874746578742f706c61696e",
	"445901012659413101000000020040006a00000019b50711445943310102080018001c00000022a2a5b3fee3b2fcea7734a98d065b42a2c6ca5d28b0ef288c3a7c62ba3dd5af6e6f74652e747874746578742f706c61696e",
	"445901012659413102000000020040006a00000019b507117f3a2b5073716d74257568662d3866c3d1d2a782dddc841640c0fb637b21cdabba3c5cd98d41e053081bba3dd5af6e6f74652e747874746578742f706c61696e",
	"445901012659413107000000020040006a00000019b50711445943310102080018001c00000022a2a5b3fee3b2fcea7734a98d065b42a2c6ca5d28b0ef288c3a7c62ba3dd5af6e6f74652e747874746578742f706c61696e",
	"44590101265941311f000000020040006a00000019b507117f3a2b5073716d74257568662d3866c3d1d2a782dddc841640c0fb637b21cdabba3c5cd98d41e053081bba3dd5af6e6f74652e747874746578742f706c61696e",
}

func mustDecodeHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestTypeScriptProtocolFixture(t *testing.T) {
	source := []byte("DataYao native compatibility")
	payload, err := packTransfer("note.txt", "text/plain;charset=utf-8", source, true)
	if err != nil {
		t.Fatal(err)
	}
	expectedContainer := mustDecodeHex(t, fixtureContainerHex)
	if hex.EncodeToString(payload.container) != hex.EncodeToString(expectedContainer) {
		t.Fatalf("container mismatch\nwant %x\n got %x", expectedContainer, payload.container)
	}

	const sessionID uint32 = 0x31415926
	const blockSize = 64
	encoder := newFountainEncoder(payload.container, blockSize, sessionID)
	header := makeHeader(payload.container, blockSize, sessionID, 1)
	sequences := []uint32{0, 1, 2, 7, 31}
	for index, sequence := range sequences {
		header.sequence = sequence
		frame, packErr := packFrame(header, encoder.encode(sequence))
		if packErr != nil {
			t.Fatal(packErr)
		}
		expected := mustDecodeHex(t, fixtureFrameHex[index])
		if hex.EncodeToString(frame) != hex.EncodeToString(expected) {
			t.Fatalf("frame %d mismatch\nwant %x\n got %x", sequence, expected, frame)
		}
	}
}

func TestV2FrameLayoutForLargeStreams(t *testing.T) {
	header := frameHeader{
		flags:       1,
		sessionID:   0x12345678,
		sequence:    0x89abcdef,
		blockCount:  0x10000,
		blockSize:   1200,
		totalLength: 0x10000 * 1200,
		payloadCRC:  0xdeadbeef,
	}
	block := make([]byte, 1200)
	for index := range block {
		block[index] = byte(index)
	}
	frame, err := packFrame(header, block)
	if err != nil {
		t.Fatal(err)
	}
	if len(frame) != 26+1200 {
		t.Fatalf("v2 frame length = %d, want %d", len(frame), 26+1200)
	}
	if frame[2] != 2 {
		t.Fatalf("v2 frame version byte = %d, want 2", frame[2])
	}
	if binary.LittleEndian.Uint32(frame[12:16]) != 0x10000 {
		t.Fatal("v2 blockCount not stored as u32")
	}
	if binary.LittleEndian.Uint16(frame[16:18]) != 1200 {
		t.Fatal("v2 blockSize mismatch")
	}
	if binary.LittleEndian.Uint32(frame[18:22]) != header.totalLength {
		t.Fatal("v2 totalLength mismatch")
	}
	if binary.LittleEndian.Uint32(frame[22:26]) != 0xdeadbeef {
		t.Fatal("v2 payloadCRC mismatch")
	}

	small := header
	small.blockCount = 10
	small.totalLength = 10 * 1200
	frame, err = packFrame(small, block)
	if err != nil {
		t.Fatal(err)
	}
	if len(frame) != 24+1200 || frame[2] != 1 {
		t.Fatalf("small stream should stay on the v1 header, got len=%d version=%d", len(frame), frame[2])
	}
}
