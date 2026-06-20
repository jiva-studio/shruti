package sqlitecatalog

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func (l *Lazy) GetKeyValue(ctx context.Context, key string) (string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return "", false, err
	}
	defer r.Close()
	return r.GetKeyValue(ctx, key)
}

func (l *Lazy) SetKeyValue(ctx context.Context, key, value string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetKeyValue(ctx, key, value); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) ListKeyValues(ctx context.Context, prefix string) ([]catalog.KeyValuePair, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListKeyValues(ctx, prefix)
}
