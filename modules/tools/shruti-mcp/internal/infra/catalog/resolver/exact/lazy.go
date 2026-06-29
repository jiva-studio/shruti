package exact

import (
	"context"
	"fmt"
	"os"

	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// LazyResolver checks current.db is on disk, then delegates to a stateless
// exact-match Resolver. Path is retained as a refresh-existence guard —
// Resolve still works only against req.Candidates, no SQL queries needed.
type LazyResolver struct{ Path string }

func NewLazy(path string) *LazyResolver { return &LazyResolver{Path: path} }

func (l *LazyResolver) Name() string { return "exact" }

func (l *LazyResolver) Resolve(ctx context.Context, req catalogport.ResolveRequest) (catalogport.ResolveResponse, error) {
	if _, err := os.Stat(l.Path); err != nil {
		return catalogport.ResolveResponse{}, fmt.Errorf("catalog not refreshed yet (%s) — run catalog_refresh first", l.Path)
	}
	return New().Resolve(ctx, req)
}

var _ catalogport.Resolver = (*LazyResolver)(nil)
