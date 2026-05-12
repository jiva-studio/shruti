package nanoid

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
)

// Alphabet is the 62-char [A-Za-z0-9] set used for catalog IDs by
// content-db-builder/idMap.ts. We reuse it for both lake trackIds and
// dict IDs created via catalog CRUD.
const Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// TailLength matches content-db-builder.
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
