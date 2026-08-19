package main

import (
	"encoding/binary"
	"hash/crc32"
	"math"
)

const audioSampleRate = 48000

type audioProfile int

const (
	audioStable audioProfile = iota
	audioFast
)

var audioLow = [...]float64{697, 770, 852, 941}
var audioHigh = [...]float64{1209, 1336, 1477, 1633}

func audioTiming(profile audioProfile) (toneMs, gapMs int) {
	if profile == audioFast {
		return 18, 10
	}
	return 20, 10
}

func audioFrameDurationMs(frameLength int, profile audioProfile) int {
	toneMs, gapMs := audioTiming(profile)
	nibbleCount := 8 + (2+frameLength+4)*2
	return 180 + 80 + nibbleCount*(toneMs+gapMs) + 100
}

func encodeAudioWAV(frame []byte, profile audioProfile) []byte {
	return encodeAudioWAVAtRate(frame, profile, audioSampleRate)
}

func encodeAudioWAVAtRate(frame []byte, profile audioProfile, sampleRate int) []byte {
	toneMs, gapMs := audioTiming(profile)
	packet := make([]byte, 2+len(frame)+4)
	binary.BigEndian.PutUint16(packet[0:2], uint16(len(frame)))
	copy(packet[2:], frame)
	binary.BigEndian.PutUint32(packet[2+len(frame):], crc32.ChecksumIEEE(frame))
	nibbles := make([]byte, 0, 8+len(packet)*2)
	nibbles = append(nibbles, 0xf, 0x0, 0xf, 0x0, 0xd, 0xa, 0x7, 0xa)
	for _, value := range packet {
		nibbles = append(nibbles, value>>4, value&0xf)
	}
	sampleCount := int(math.Ceil(float64(sampleRate*audioFrameDurationMs(len(frame), profile)) / 1000))
	pcm := make([]int16, sampleCount)
	offset := sampleRate * 35 / 1000
	offset = writeAudioPilot(pcm, offset, sampleRate)
	offset += sampleRate * 80 / 1000
	for _, value := range nibbles {
		offset = writeAudioTone(pcm, offset, toneMs, audioLow[(value>>2)&3], audioHigh[value&3], sampleRate)
		offset += sampleRate * gapMs / 1000
	}
	wav := make([]byte, 44+len(pcm)*2)
	copy(wav[0:4], []byte("RIFF"))
	binary.LittleEndian.PutUint32(wav[4:8], uint32(len(wav)-8))
	copy(wav[8:12], []byte("WAVE"))
	copy(wav[12:16], []byte("fmt "))
	binary.LittleEndian.PutUint32(wav[16:20], 16)
	binary.LittleEndian.PutUint16(wav[20:22], 1)
	binary.LittleEndian.PutUint16(wav[22:24], 1)
	binary.LittleEndian.PutUint32(wav[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(wav[28:32], uint32(sampleRate*2))
	binary.LittleEndian.PutUint16(wav[32:34], 2)
	binary.LittleEndian.PutUint16(wav[34:36], 16)
	copy(wav[36:40], []byte("data"))
	binary.LittleEndian.PutUint32(wav[40:44], uint32(len(pcm)*2))
	for index, value := range pcm {
		binary.LittleEndian.PutUint16(wav[44+index*2:], uint16(value))
	}
	return wav
}

func writeAudioPilot(output []int16, offset, sampleRate int) int {
	length := sampleRate * 180 / 1000
	ramp := sampleRate * 8 / 1000
	for index := 0; index < length && offset+index < len(output); index++ {
		envelope := math.Min(1, math.Min(float64(index+1)/float64(ramp), float64(length-index)/float64(ramp)))
		value := math.Sin(2*math.Pi*1800*float64(index)/float64(sampleRate)) * 0.24 * envelope
		output[offset+index] = int16(value * 32767)
	}
	return offset + length
}

func writeAudioTone(output []int16, offset, durationMs int, low, high float64, sampleRate int) int {
	length := sampleRate * durationMs / 1000
	ramp := sampleRate * 2 / 1000
	for index := 0; index < length && offset+index < len(output); index++ {
		envelope := math.Min(1, math.Min(float64(index+1)/float64(ramp), float64(length-index)/float64(ramp)))
		value := (math.Sin(2*math.Pi*low*float64(index)/float64(sampleRate)) + math.Sin(2*math.Pi*high*float64(index)/float64(sampleRate))) * 0.17 * envelope
		output[offset+index] = int16(value * 32767)
	}
	return offset + length
}
