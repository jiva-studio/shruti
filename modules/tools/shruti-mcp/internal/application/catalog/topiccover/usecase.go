// Package topiccover adapts a topic to covergen.Repo: it reads a topic's
// locale-picked full name as the cover prompt seed (topics carry no
// description) and stores the generated cover key on the topic. The image
// pipeline itself lives in covergen.
package topiccover

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/catalog/covergen"
)

// Catalog is the slice of the topic repository this adapter needs.
type Catalog interface {
	GetTopicName(ctx context.Context, id, language string) (string, bool, error)
	SetTopicCover(ctx context.Context, id, cover string) error
}

// Repo bridges the topic catalog to covergen.Repo.
type Repo struct {
	Catalog Catalog
}

func (r Repo) CoverSubject(ctx context.Context, id, language string) (covergen.Subject, bool, error) {
	name, ok, err := r.Catalog.GetTopicName(ctx, id, language)
	if err != nil || !ok {
		return covergen.Subject{}, ok, err
	}
	return covergen.Subject{Name: name}, true, nil
}

func (r Repo) SetCover(ctx context.Context, id, key string) error {
	return r.Catalog.SetTopicCover(ctx, id, key)
}
