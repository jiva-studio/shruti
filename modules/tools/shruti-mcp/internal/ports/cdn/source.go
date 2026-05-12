package cdn

import (
	"context"
	"io"
)

// Source fetches public/* files anonymously over HTTPS. Used by catalog_refresh.
type Source interface {
	GetJSON(ctx context.Context, key string, out any) error // unmarshals into out
	GetFile(ctx context.Context, key string) (io.ReadCloser, error)
}
