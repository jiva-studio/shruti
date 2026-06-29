package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

func (l *Lazy) GetSetting(ctx context.Context, key string) (string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return "", false, err
	}
	defer r.Close()
	return r.GetSetting(ctx, key)
}

func (l *Lazy) SetSetting(ctx context.Context, key, value string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetSetting(ctx, key, value); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) ListSettings(ctx context.Context, prefix string) ([]catalog.Setting, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListSettings(ctx, prefix)
}
