// Package ports declares storage-sync's driven interfaces — the extension
// surface the mirroring core depends on. The Bunny HTTP adapter and the Yandex
// S3 adapter implement these, so a full pass and an event-driven sync are both
// exercised with in-memory fakes (no Bunny, no S3, no Redis).
package ports

import (
	"context"
	"io"

	"github.com/jiva-studio/shruti-storage-sync/internal/domain/mirror"
)

// SourceStore reads the source of truth (Bunny Edge Storage).
//
// Walk is the full-pass listing; Stat is the single-key lookup the event-driven
// path uses (it must not walk the corpus to ship two objects). Open streams a
// body for transfer and reports the source Content-Type so the mirror can
// preserve it.
type SourceStore interface {
	Walk(ctx context.Context, prefix string) (map[string]mirror.Object, error)
	Stat(ctx context.Context, key string) (obj mirror.Object, found bool, err error)
	Open(ctx context.Context, key string) (body io.ReadCloser, contentType string, err error)
}

// MirrorStore reads and writes the Russia mirror (Yandex Object Storage).
//
// Put MUST persist obj.SHA256 as object metadata — that stamp is what lets the
// next pass decide by checksum instead of re-downloading (see
// mirror.NeedsTransfer).
type MirrorStore interface {
	State(ctx context.Context, key string) (mirror.MirrorState, error)
	Put(ctx context.Context, obj mirror.Object, body io.Reader, contentType string) error
	ListKeys(ctx context.Context, prefix string) ([]string, error)
	DeleteKeys(ctx context.Context, keys []string) (int, error)
}
