package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func (s *Store) CreateDailyWisdom(ctx context.Context, w catalog.DailyWisdom) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.CreateDailyWisdom(ctx, w); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) ListDailyWisdom(ctx context.Context, topicID, language string, limit int) ([]catalog.DailyWisdom, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListDailyWisdom(ctx, topicID, language, limit)
}

func (s *Store) DeleteDailyWisdom(ctx context.Context, id string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteDailyWisdom(ctx, id); err != nil {
		return err
	}
	return markModified(s.path)
}
