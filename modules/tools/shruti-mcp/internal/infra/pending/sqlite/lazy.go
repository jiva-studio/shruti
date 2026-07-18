package sqlitepending

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pending"
	pendingport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/pending"
)

// Lazy opens pending.db on demand — same pattern as sqlitecatalog.Lazy /
// sqlitelibrary.Lazy. Each call opens, runs, and closes.
type Lazy struct{ Path string }

func NewLazy(path string) *Lazy { return &Lazy{Path: path} }

func (l *Lazy) Close() error { return nil }

func (l *Lazy) open(ctx context.Context) (*Repo, error) {
	if err := os.MkdirAll(filepath.Dir(l.Path), 0o755); err != nil {
		return nil, fmt.Errorf("ensure pending dir: %w", err)
	}
	return Open(ctx, l.Path)
}

func (l *Lazy) List(ctx context.Context, opts pending.ListOpts) ([]pending.Track, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.List(ctx, opts)
}

func (l *Lazy) Get(ctx context.Context, trackID string) (pending.Track, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return pending.Track{}, false, err
	}
	defer r.Close()
	return r.Get(ctx, trackID)
}

func (l *Lazy) MarkConsumed(ctx context.Context, trackID string) (bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return false, err
	}
	defer r.Close()
	return r.MarkConsumed(ctx, trackID)
}

var _ pendingport.Reader = (*Lazy)(nil)
