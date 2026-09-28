package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func (s *Store) GetSetting(ctx context.Context, key string) (string, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return "", false, err
	}
	defer release()
	return r.GetSetting(ctx, key)
}

func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetSetting(ctx, key, value); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) ListSettings(ctx context.Context, prefix string) ([]catalog.Setting, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListSettings(ctx, prefix)
}
