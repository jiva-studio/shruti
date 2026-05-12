package nanoid

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
)

// Alphabet is the 62-char [A-Za-z0-9] set used for every Lectorium
// catalog id (track ids, dict ids). Locked to this set so published
// catalogs stay stable across minter changes.
const Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// TailLength is the canonical Lectorium id-tail width (`<prefix>_<12 alnum>`).
const TailLength = 12

// Minter implements ports/ids.Minter using crypto/rand.
type Minter struct{}

func New() *Minter { return &Minter{} }

func (Minter) MintTail() string {
	out := make([]byte, TailLength)
	buf := make([]byte, TailLength*4) // 4 bytes per char, plenty of entropy
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Errorf("nanoid: rand: %w", err))
	}
	alphaLen := uint32(len(Alphabet))
	for i := 0; i < TailLength; i++ {
		v := binary.LittleEndian.Uint32(buf[i*4 : i*4+4])
		out[i] = Alphabet[v%alphaLen]
	}
	return string(out)
}
