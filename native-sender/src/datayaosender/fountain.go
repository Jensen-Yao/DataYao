package main

import "math"

const (
	ln2          = 0.6931471805599453
	solitonC     = 0.1
	solitonDelta = 0.5
)

type splitmix struct {
	state uint32
}

func (random *splitmix) next() uint32 {
	random.state += 0x9e3779b9
	value := random.state ^ (random.state >> 16)
	value *= 0x21f0aaad
	value ^= value >> 15
	value *= 0x735a2d97
	value ^= value >> 15
	return value
}

func deterministicLog(value float64) float64 {
	exponent := 0
	mantissa := value
	for mantissa >= 1.5 {
		mantissa /= 2
		exponent++
	}
	for mantissa < 0.75 {
		mantissa *= 2
		exponent--
	}
	z := (mantissa - 1) / (mantissa + 1)
	z2 := z * z
	term := z
	sum := 0.0
	for n := 1; n <= 21; n += 2 {
		sum += term / float64(n)
		term *= z2
	}
	return float64(exponent)*ln2 + 2*sum
}

func solitonCDF(count int) []float64 {
	cdf := make([]float64, count)
	if count <= 1 {
		cdf[0] = 1
		return cdf
	}
	radius := solitonC * deterministicLog(float64(count)/solitonDelta) * math.Sqrt(float64(count))
	if radius < 1 {
		radius = 1
	}
	spike := int(math.Ceil(float64(count) / radius))
	if spike > count {
		spike = count
	}
	total := 0.0
	for degree := 1; degree <= count; degree++ {
		rho := 1.0 / float64(count)
		if degree != 1 {
			rho = 1.0 / float64(degree*(degree-1))
		}
		tau := 0.0
		if degree < spike {
			tau = radius / float64(degree*count)
		} else if degree == spike {
			logValue := deterministicLog(radius / solitonDelta)
			if logValue < 0 {
				logValue = 0
			}
			tau = radius * logValue / float64(count)
		}
		total += rho + tau
		cdf[degree-1] = total
	}
	for index := range cdf {
		cdf[index] /= total
	}
	cdf[count-1] = 1
	return cdf
}

func frameSeed(sessionID, sequence uint32) uint32 {
	hash := (sessionID+1)*0x9e3779b1 ^ (sequence + 0x85ebca6b)
	hash = (hash ^ (hash >> 13)) * 0xc2b2ae35
	return hash ^ (hash >> 16)
}

func frameIndices(count int, cdf []float64, sessionID, sequence uint32) []int {
	random := splitmix{state: frameSeed(sessionID, sequence)}
	unit := float64(random.next()) / 4294967296.0
	low := 0
	high := count - 1
	for low < high {
		middle := (low + high) >> 1
		if cdf[middle] >= unit {
			high = middle
		} else {
			low = middle + 1
		}
	}
	degree := low + 1
	if degree > count {
		degree = count
	}
	if degree > count>>3 {
		scratch := make([]int, count)
		for index := range scratch {
			scratch[index] = index
		}
		output := make([]int, degree)
		for index := 0; index < degree; index++ {
			swapIndex := index + int(random.next()%uint32(count-index))
			scratch[index], scratch[swapIndex] = scratch[swapIndex], scratch[index]
			output[index] = scratch[index]
		}
		return output
	}
	selected := make(map[int]bool)
	output := make([]int, 0, degree)
	for len(output) < degree {
		index := int(random.next() % uint32(count))
		if !selected[index] {
			selected[index] = true
			output = append(output, index)
		}
	}
	return output
}

type fountainEncoder struct {
	blockSize int
	sessionID uint32
	blocks    [][]byte
	cdf       []float64
}

func newFountainEncoder(payload []byte, blockSize int, sessionID uint32) *fountainEncoder {
	count := (len(payload) + blockSize - 1) / blockSize
	if count < 1 {
		count = 1
	}
	blocks := make([][]byte, count)
	for index := 0; index < count; index++ {
		blocks[index] = make([]byte, blockSize)
		start := index * blockSize
		end := start + blockSize
		if end > len(payload) {
			end = len(payload)
		}
		copy(blocks[index], payload[start:end])
	}
	return &fountainEncoder{
		blockSize: blockSize,
		sessionID: sessionID,
		blocks:    blocks,
		cdf:       solitonCDF(count),
	}
}

func (encoder *fountainEncoder) encode(sequence uint32) []byte {
	output := make([]byte, encoder.blockSize)
	indices := frameIndices(len(encoder.blocks), encoder.cdf, encoder.sessionID, sequence)
	for _, blockIndex := range indices {
		block := encoder.blocks[blockIndex]
		for index := range output {
			output[index] ^= block[index]
		}
	}
	return output
}
