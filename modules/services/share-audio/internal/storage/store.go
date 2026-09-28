// Package storage is the storage zone the cut pipeline reads and writes.
package storage

import "context"

// Store is what the cut pipeline needs from storage: probe a key, upload an
// excerpt, and compose the public URL of a key.
type Store interface {
	Exists(ctx context.Context, key string) (bool, error)
	Upload(ctx context.Context, key, localPath, contentType, cacheControl string) error
	BuildURL(key string) string
}
