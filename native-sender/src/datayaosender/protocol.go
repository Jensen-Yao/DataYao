package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io/ioutil"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	frameHeaderSize  = 24
	frameHeaderSize2 = 26
	containerHeader  = 46
	maxFileBytes     = 256 * 1024 * 1024
	maxContainerSize = maxFileBytes + 1024*1024
	protocolVersion  = 1
	protocolVersion2 = 2
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
	blockCount  uint32
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
		blockCount:  uint32(count),
		blockSize:   uint16(blockSize),
		totalLength: uint32(len(payload)),
		payloadCRC:  crc32.ChecksumIEEE(payload),
	}
}

func packFrame(header frameHeader, block []byte) ([]byte, error) {
	if header.blockCount < 1 {
		return nil, errors.New("blockCount 超出协议范围")
	}
	// v1 keeps blockCount in a u16; larger streams upgrade to the v2 frame
	// header (u32 blockCount) which current receivers also accept.
	version := byte(protocolVersion)
	headerSize := frameHeaderSize
	if header.blockCount > 0xffff {
		version = protocolVersion2
		headerSize = frameHeaderSize2
	}
	frame := make([]byte, headerSize+int(header.blockSize))
	frame[0] = 'D'
	frame[1] = 'Y'
	frame[2] = version
	frame[3] = header.flags
	binary.LittleEndian.PutUint32(frame[4:8], header.sessionID)
	binary.LittleEndian.PutUint32(frame[8:12], header.sequence)
	if version == protocolVersion2 {
		binary.LittleEndian.PutUint32(frame[12:16], header.blockCount)
		binary.LittleEndian.PutUint16(frame[16:18], header.blockSize)
		binary.LittleEndian.PutUint32(frame[18:22], header.totalLength)
		binary.LittleEndian.PutUint32(frame[22:26], header.payloadCRC)
	} else {
		binary.LittleEndian.PutUint16(frame[12:14], uint16(header.blockCount))
		binary.LittleEndian.PutUint16(frame[14:16], header.blockSize)
		binary.LittleEndian.PutUint32(frame[16:20], header.totalLength)
		binary.LittleEndian.PutUint32(frame[20:24], header.payloadCRC)
	}
	copy(frame[headerSize:], block)
	return frame, nil
}

// parseFrame mirrors the TypeScript receiver: both the 24-byte v1 header and
// the 26-byte v2 header (u32 blockCount) are accepted.
func parseFrame(frame []byte) (frameHeader, []byte, error) {
	if len(frame) < frameHeaderSize || frame[0] != 'D' || frame[1] != 'Y' {
		return frameHeader{}, nil, errors.New("不是 DataYao 帧")
	}
	version := frame[2]
	if version != protocolVersion && version != protocolVersion2 {
		return frameHeader{}, nil, fmt.Errorf("不支持的协议版本 %d", version)
	}
	headerSize := frameHeaderSize
	if version == protocolVersion2 {
		headerSize = frameHeaderSize2
	}
	if len(frame) < headerSize {
		return frameHeader{}, nil, errors.New("帧头不完整")
	}
	header := frameHeader{
		flags:       frame[3],
		sessionID:   binary.LittleEndian.Uint32(frame[4:8]),
		sequence:    binary.LittleEndian.Uint32(frame[8:12]),
		blockCount:  0,
		blockSize:   0,
		totalLength: 0,
		payloadCRC:  0,
	}
	if version == protocolVersion2 {
		header.blockCount = binary.LittleEndian.Uint32(frame[12:16])
		header.blockSize = binary.LittleEndian.Uint16(frame[16:18])
		header.totalLength = binary.LittleEndian.Uint32(frame[18:22])
		header.payloadCRC = binary.LittleEndian.Uint32(frame[22:26])
	} else {
		header.blockCount = uint32(binary.LittleEndian.Uint16(frame[12:14]))
		header.blockSize = binary.LittleEndian.Uint16(frame[14:16])
		header.totalLength = binary.LittleEndian.Uint32(frame[16:20])
		header.payloadCRC = binary.LittleEndian.Uint32(frame[20:24])
	}
	if header.blockCount < 1 || header.blockSize < 1 || header.totalLength < 1 || header.totalLength > maxContainerSize {
		return frameHeader{}, nil, errors.New("帧头字段无效")
	}
	if header.totalLength > header.blockCount*uint32(header.blockSize) ||
		header.totalLength <= (header.blockCount-1)*uint32(header.blockSize) {
		return frameHeader{}, nil, errors.New("帧头尺寸不一致")
	}
	if len(frame) != headerSize+int(header.blockSize) {
		return frameHeader{}, nil, errors.New("帧长度不匹配")
	}
	return header, frame[headerSize:], nil
}

func streamKey(header frameHeader) string {
	return fmt.Sprintf("%d:%d:%d:%d:%d:%d",
		header.sessionID, header.blockCount, header.blockSize, header.totalLength, header.payloadCRC, header.flags)
}

type unpackedTransfer struct {
	fileName   string
	mimeType   string
	bytes      []byte
	isText     bool
	compressed bool
}

func unpackTransfer(container []byte) (*unpackedTransfer, error) {
	if len(container) < containerHeader || len(container) > maxContainerSize {
		return nil, errors.New("传输容器长度无效")
	}
	if !bytes.Equal(container[0:4], []byte{'D', 'Y', 'C', '1'}) || container[4] != 1 {
		return nil, errors.New("不支持的 DataYao 容器")
	}
	flags := container[5]
	nameLength := int(binary.LittleEndian.Uint16(container[6:8]))
	typeLength := int(binary.LittleEndian.Uint16(container[8:10]))
	originalLength := binary.LittleEndian.Uint32(container[10:14])
	if originalLength > maxFileBytes {
		return nil, errors.New("恢复文件超过 256 MB 限制")
	}
	metadataEnd := containerHeader + nameLength + typeLength
	if metadataEnd > len(container) {
		return nil, errors.New("传输容器元数据损坏")
	}
	fileName := cleanName(string(container[containerHeader : containerHeader+nameLength]))
	mimeType := string(container[containerHeader+nameLength : metadataEnd])
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	data := container[metadataEnd:]
	if flags&1 != 0 {
		reader, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, errors.New("压缩数据无法解压")
		}
		decompressed, err := ioutil.ReadAll(reader)
		if err != nil {
			return nil, errors.New("压缩数据无法解压")
		}
		reader.Close()
		data = decompressed
	}
	if uint32(len(data)) != originalLength {
		return nil, errors.New("恢复文件长度校验失败")
	}
	digest := sha256.Sum256(data)
	if !bytes.Equal(container[14:46], digest[:]) {
		return nil, errors.New("SHA-256 校验失败，数据可能损坏")
	}
	return &unpackedTransfer{
		fileName:   fileName,
		mimeType:   mimeType,
		bytes:      data,
		isText:     flags&2 != 0,
		compressed: flags&1 != 0,
	}, nil
}
