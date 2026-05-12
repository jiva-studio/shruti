// Package hashing is the port for content-addressing source files.
// The default sha256 implementation lives in internal/infra/hashing/sha256.
package hashing

import "context"

type Hasher interface {
	// HashFile streams the file at path through the hash function and returns
	// its hex digest. Implementations must close any handles they open.
	HashFile(ctx context.Context, path string) (string, error)
}
