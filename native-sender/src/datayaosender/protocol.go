package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	frameHeaderSize  = 24
	containerHeader  = 46
	maxFileBytes     = 64 * 1024 * 1024
	maxContainerSize = maxFileBytes + 64*1024
	protocolVersion  = 1
)

type transferPayload struct {
	container   []byte
	fileName    string
	mimeType    string
	originalLen int
	compressed  bool
	isText      bool
}

type frameHeader struct {
	flags       byte
	sessionID   uint32
	sequence    uint32
	blockCount  uint16
	blockSize   uint16
	totalLength uint32
	payloadCRC  uint32
}

func cleanName(name string) string {
	name = strings.Replace(name, "/", "\\", -1)
	name = filepath.Base(name)
	var output bytes.Buffer
	for len(name) > 0 {
		r, size := utf8.DecodeRuneInString(name)
		if r == utf8.RuneError && size == 1 {
			name = name[1:]
			continue
		}
		if r >= 0x20 && r != 0x7f {
			output.WriteRune(r)
		}
		name = name[size:]
	}
	result := strings.TrimSpace(output.String())
	if result == "" || result == "." || result == ".." {
		return "datayao-transfer.bin"
	}
	return result
}

func packTransfer(name, mimeType string, data []byte, isText bool) (*transferPayload, error) {
	if len(data) == 0 {
		return nil, errors.New("不能传输空文件")
	}
	if len(data) > maxFileBytes {
		return nil, errors.New("文件超过 64 MB 限制")
	}

	fileName := cleanName(name)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	transmitted := data
	compressed := false
	if len(data) >= 512 {
		var buffer bytes.Buffer
		writer, err := gzip.NewWriterLevel(&buffer, 6)
		if err != nil {
			return nil, err
		}
		if _, err = writer.Write(data); err != nil {
			return nil, err
		}
		if err = writer.Close(); err != nil {
			return nil, err
		}
		if buffer.Len()+16 < len(data) {
			transmitted = append([]byte(nil), buffer.Bytes()...)
			compressed = true
		}
	}

	nameBytes := []byte(fileName)
	typeBytes := []byte(mimeType)
	if len(nameBytes) > 0xffff || len(typeBytes) > 0xffff {
		return nil, errors.New("文件元数据过长")
	}
	container := make([]byte, containerHeader+len(nameBytes)+len(typeBytes)+len(transmitted))
	copy(container[0:4], []byte{'D', 'Y', 'C', '1'})
	container[4] = 1
	if compressed {
		container[5] |= 1
	}
	if isText {
		container[5] |= 2
	}
	binary.LittleEndian.PutUint16(container[6:8], uint16(len(nameBytes)))
	binary.LittleEndian.PutUint16(container[8:10], uint16(len(typeBytes)))
	binary.LittleEndian.PutUint32(container[10:14], uint32(len(data)))
	digest := sha256.Sum256(data)
	copy(container[14:46], digest[:])
	position := containerHeader
	copy(container[position:], nameBytes)
	position += len(nameBytes)
	copy(container[position:], typeBytes)
	position += len(typeBytes)
	copy(container[position:], transmitted)
	if len(container) > maxContainerSize {
		return nil, errors.New("传输容器超过安全上限")
	}
	return &transferPayload{
		container:   container,
		fileName:    fileName,
		mimeType:    mimeType,
		originalLen: len(data),
		compressed:  compressed,
		isText:      isText,
	}, nil
}

func makeHeader(payload []byte, blockSize int, sessionID uint32, flags byte) frameHeader {
	count := (len(payload) + blockSize - 1) / blockSize
	if count < 1 {
		count = 1
	}
	return frameHeader{
		flags:       flags,
		sessionID:   sessionID,
		blockCount:  uint16(count),
		blockSize:   uint16(blockSize),
		totalLength: uint32(len(payload)),
		payloadCRC:  crc32.ChecksumIEEE(payload),
	}
}

func packFrame(header frameHeader, block []byte) ([]byte, error) {
	if header.blockCount < 1 {
		return nil, errors.New("blockCount 超出协议范围")
	}
	frame := make([]byte, frameHeaderSize+int(header.blockSize))
	frame[0] = 'D'
	frame[1] = 'Y'
	frame[2] = protocolVersion
	frame[3] = header.flags
	binary.LittleEndian.PutUint32(frame[4:8], header.sessionID)
	binary.LittleEndian.PutUint32(frame[8:12], header.sequence)
	binary.LittleEndian.PutUint16(frame[12:14], header.blockCount)
	binary.LittleEndian.PutUint16(frame[14:16], header.blockSize)
	binary.LittleEndian.PutUint32(frame[16:20], header.totalLength)
	binary.LittleEndian.PutUint32(frame[20:24], header.payloadCRC)
	copy(frame[frameHeaderSize:], block)
	return frame, nil
}
