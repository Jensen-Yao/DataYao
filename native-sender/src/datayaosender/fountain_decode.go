package main

// LT fountain decoder, ported 1:1 from the TypeScript receiver so the same
// frames decode identically on every platform.

type pendingFrame struct {
	indices map[int]bool
	data    []byte
}

type fountainDecoder struct {
	blockCount   int
	blockSize    int
	sessionID    uint32
	totalLength  int
	cdf          []float64
	solved       [][]byte
	waiting      map[int]map[*pendingFrame]bool
	seen         map[uint32]bool
	solvedCount  int
	framesNew    int
	framesRepeat int
}

func newFountainDecoder(blockCount, blockSize int, sessionID uint32, totalLength int) *fountainDecoder {
	return &fountainDecoder{
		blockCount:  blockCount,
		blockSize:   blockSize,
		sessionID:   sessionID,
		totalLength: totalLength,
		cdf:         solitonCDF(blockCount),
		solved:      make([][]byte, blockCount),
		waiting:     make(map[int]map[*pendingFrame]bool),
		seen:        make(map[uint32]bool),
	}
}

func (decoder *fountainDecoder) complete() bool {
	return decoder.solvedCount == decoder.blockCount
}

func (decoder *fountainDecoder) add(sequence uint32, data []byte) {
	if decoder.seen[sequence] {
		decoder.framesRepeat++
		return
	}
	decoder.seen[sequence] = true
	decoder.framesNew++
	if decoder.complete() {
		return
	}

	indicesSet := make(map[int]bool)
	for _, index := range frameIndices(decoder.blockCount, decoder.cdf, decoder.sessionID, sequence) {
		indicesSet[index] = true
	}
	reduced := make([]byte, decoder.blockSize)
	copy(reduced, data[:decoder.blockSize])
	for index := range indicesSet {
		if solved := decoder.solved[index]; solved != nil {
			xorIntoBytes(reduced, solved)
			delete(indicesSet, index)
		}
	}
	if len(indicesSet) == 0 {
		return
	}
	if len(indicesSet) == 1 {
		for index := range indicesSet {
			decoder.resolve(index, reduced)
		}
		return
	}
	pending := &pendingFrame{indices: indicesSet, data: reduced}
	for index := range indicesSet {
		bucket := decoder.waiting[index]
		if bucket == nil {
			bucket = make(map[*pendingFrame]bool)
			decoder.waiting[index] = bucket
		}
		bucket[pending] = true
	}
}

func (decoder *fountainDecoder) assemble() []byte {
	if !decoder.complete() {
		return nil
	}
	output := make([]byte, decoder.totalLength)
	for index := 0; index < decoder.blockCount; index++ {
		start := index * decoder.blockSize
		length := decoder.blockSize
		if remaining := decoder.totalLength - start; remaining < length {
			length = remaining
		}
		copy(output[start:start+length], decoder.solved[index][:length])
	}
	return output
}

func (decoder *fountainDecoder) resolve(index int, data []byte) {
	type queueEntry struct {
		index int
		data  []byte
	}
	queue := []queueEntry{{index, data}}
	for len(queue) > 0 {
		entry := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if decoder.solved[entry.index] != nil {
			continue
		}
		decoder.solved[entry.index] = entry.data
		decoder.solvedCount++
		bucket := decoder.waiting[entry.index]
		if bucket == nil {
			continue
		}
		delete(decoder.waiting, entry.index)
		for pending := range bucket {
			xorIntoBytes(pending.data, entry.data)
			delete(pending.indices, entry.index)
			if len(pending.indices) == 1 {
				next := -1
				for remaining := range pending.indices {
					next = remaining
				}
				if next < 0 {
					continue
				}
				// pending.data becomes the queued solution for next, so it
				// must leave next's bucket now or resolving next would XOR
				// the block with itself and zero it out.
				if nextBucket := decoder.waiting[next]; nextBucket != nil {
					delete(nextBucket, pending)
				}
				if decoder.solved[next] == nil {
					queue = append(queue, queueEntry{next, pending.data})
				}
			}
		}
	}
}

func xorIntoBytes(destination, source []byte) {
	for index := range destination {
		destination[index] ^= source[index]
	}
}
