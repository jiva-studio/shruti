package storage

import "context"

// Store is the storage backend the cut pipeline needs: probe a key, download a
// source object to a temp file, upload an excerpt, and compose its public URL.
// Two implementations satisfy it — the AWS-SDK Client (S3 / Yandex via endpoint
// override) and BunnyClient (Bunny Edge Storage HTTP API). The backend is
// selected at boot by config; the pipeline depends only on this interface.
type Store interface {
	Exists(ctx context.Context, key string) (bool, error)
	DownloadTo(ctx context.Context, key, dstPath string) error
	Upload(ctx context.Context, key, localPath, contentType, cacheControl string) error
	BuildURL(key string) string
}
