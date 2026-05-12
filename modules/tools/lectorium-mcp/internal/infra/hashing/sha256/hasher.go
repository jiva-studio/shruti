package sha256hash

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/hashing"
)

type Hasher struct{}

func New() Hasher { return Hasher{} }

func (Hasher) HashFile(ctx context.Context, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

var _ hashing.Hasher = (*Hasher)(nil)
