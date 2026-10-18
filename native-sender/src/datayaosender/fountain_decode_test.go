package main

import (
	"bytes"
	"math/rand"
	"testing"
)

func TestFountainDecoderRecoversOutOfOrderPayload(t *testing.T) {
	source := make([]byte, 6000)
	random := rand.New(rand.NewSource(42))
	random.Read(source)

	const sessionID uint32 = 0x31415926
	const blockSize = 64
	encoder := newFountainEncoder(source, blockSize, sessionID)
	decoder := newFountainDecoder(len(encoder.blocks), blockSize, sessionID, len(source))

	order := make([]uint32, 0, len(encoder.blocks)*2)
	for sequence := uint32(0); sequence < uint32(len(encoder.blocks))*2; sequence++ {
		order = append(order, sequence)
	}
	random.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })

	for _, sequence := range order {
		if decoder.complete() {
			break
		}
		// A tenth of the frames never arrive; a tenth arrive twice.
		if sequence%10 == 3 {
			continue
		}
		block := encoder.encode(sequence)
		decoder.add(sequence, block)
		if sequence%10 == 7 {
			decoder.add(sequence, encoder.encode(sequence))
		}
	}

	if !decoder.complete() {
		t.Fatalf("decoder stalled: solved %d of %d blocks", decoder.solvedCount, decoder.blockCount)
	}
	assembled := decoder.assemble()
	if !bytes.Equal(assembled, source) {
		t.Fatal("assembled payload differs from source")
	}
	if decoder.framesRepeat == 0 {
		t.Fatal("expected duplicate frames to be counted")
	}
}

func TestParseFrameAcceptsV1AndV2(t *testing.T) {
	v1 := frameHeader{flags: 1, sessionID: 5, sequence: 6, blockCount: 9, blockSize: 256, totalLength: 2304, payloadCRC: 77}
	block := make([]byte, 256)
	for index := range block {
		block[index] = byte(index * 3)
	}
	frame, err := packFrame(v1, block)
	if err != nil {
		t.Fatal(err)
	}
	parsed, parsedBlock, err := parseFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if parsed != v1 || !bytes.Equal(parsedBlock, block) || streamKey(parsed) == "" {
		t.Fatalf("v1 round trip mismatch: %+v", parsed)
	}

	v2 := v1
	v2.blockCount = 0x10000
	v2.totalLength = 0x10000 * 256
	frame, err = packFrame(v2, block)
	if err != nil {
		t.Fatal(err)
	}
	parsed, parsedBlock, err = parseFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.blockCount != 0x10000 || parsed.blockSize != 256 || parsed.totalLength != 0x10000*256 || !bytes.Equal(parsedBlock, block) {
		t.Fatalf("v2 round trip mismatch: %+v", parsed)
	}

	corrupt := append([]byte(nil), frame...)
	corrupt[2] = 9
	if _, _, err := parseFrame(corrupt); err == nil {
		t.Fatal("unknown version should be rejected")
	}
}

func TestUnpackTransferRoundTrip(t *testing.T) {
	source := []byte("DataYao native receive unpack test payload")
	payload, err := packTransfer("receive.txt", "text/plain;charset=utf-8", source, true)
	if err != nil {
		t.Fatal(err)
	}
	unpacked, err := unpackTransfer(payload.container)
	if err != nil {
		t.Fatal(err)
	}
	if unpacked.fileName != "receive.txt" || !unpacked.isText || !bytes.Equal(unpacked.bytes, source) {
		t.Fatalf("unexpected unpack result: %+v", unpacked)
	}

	corrupt := append([]byte(nil), payload.container...)
	corrupt[len(corrupt)-1] ^= 0xff
	if _, err := unpackTransfer(corrupt); err == nil {
		t.Fatal("corrupted container must fail SHA-256 verification")
	}
}
