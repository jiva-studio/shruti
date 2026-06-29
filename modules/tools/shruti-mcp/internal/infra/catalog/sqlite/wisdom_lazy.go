package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func (l *Lazy) CreateDailyWisdom(ctx context.Context, w catalog.DailyWisdom) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.CreateDailyWisdom(ctx, w); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) ListDailyWisdom(ctx context.Context, topicID, language string, limit int) ([]catalog.DailyWisdom, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListDailyWisdom(ctx, topicID, language, limit)
}

func (l *Lazy) DeleteDailyWisdom(ctx context.Context, id string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteDailyWisdom(ctx, id); err != nil {
		return err
	}
	return markModified(l.Path)
}
