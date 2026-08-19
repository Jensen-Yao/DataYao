package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestEncodeAudioWAV(t *testing.T) {
	frame := make([]byte, 88)
	for index := range frame {
		frame[index] = byte(index*53 + 17)
	}
	wav := encodeAudioWAV(frame, audioStable)
	if len(wav) <= 44 {
		t.Fatal("WAV payload is empty")
	}
	if !bytes.Equal(wav[0:4], []byte("RIFF")) || !bytes.Equal(wav[8:12], []byte("WAVE")) {
		t.Fatal("invalid WAV header")
	}
	if binary.LittleEndian.Uint32(wav[24:28]) != audioSampleRate {
		t.Fatal("unexpected sample rate")
	}
	if binary.LittleEndian.Uint32(wav[40:44]) != uint32(len(wav)-44) {
		t.Fatal("invalid data chunk length")
	}
}
