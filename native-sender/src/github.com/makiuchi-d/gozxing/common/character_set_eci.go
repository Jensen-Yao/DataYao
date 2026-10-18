package common

import "errors"

// DataYao build note: this vendored copy decodes byte-mode QR codes only and
// consumes Result.RawBytes, so the x/text ECI transcoding tables from the
// upstream gozxing release were removed. ECI segments fail the parse, which
// DataYao frames never contain.

type CharacterSetECI struct {
	value int
	name  string
}

func (this *CharacterSetECI) GetValue() int {
	return this.value
}

func (this *CharacterSetECI) Name() string {
	return this.name
}

func GetCharacterSetECIByValue(value int) (*CharacterSetECI, error) {
	return nil, errors.New("ECI segments are not supported in this build")
}

func GetCharacterSetECIByName(name string) (*CharacterSetECI, bool) {
	return nil, false
}
