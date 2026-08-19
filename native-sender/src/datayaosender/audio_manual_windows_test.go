package main

import (
	"os"
	"testing"
	"time"
)

func TestManualAcousticTransfer(t *testing.T) {
	if os.Getenv("DATAYAO_ACOUSTIC_MANUAL") != "1" {
		t.Skip("set DATAYAO_ACOUSTIC_MANUAL=1 to play the acoustic transfer test")
	}

	payload, err := packTransfer("datayao-text.txt", "text/plain;charset=utf-8", []byte("DYTEST"), true)
	if err != nil {
		t.Fatal(err)
	}
	const blockSize = 64
	const sessionID = 0x44595453
	encoder := newFountainEncoder(payload.container, blockSize, sessionID)
	header := makeHeader(payload.container, blockSize, sessionID, 1)
	defer stopAudio()

	for sequence := uint32(0); sequence < 8; sequence++ {
		header.sequence = sequence
		frame, packErr := packFrame(header, encoder.encode(sequence))
		if packErr != nil {
			t.Fatal(packErr)
		}
		playAudioWAV(encodeAudioWAV(frame, audioStable))
		time.Sleep(time.Duration(audioFrameDurationMs(len(frame), audioStable)+120) * time.Millisecond)
	}
}
