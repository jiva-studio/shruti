// Package collectioncover adapts a collection to covergen.Repo: it reads a
// collection's locale-picked name/description as the cover prompt seed and
// stores the generated cover key on the collection. The image pipeline itself
// lives in covergen.
package collectioncover

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/catalog/covergen"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// Catalog is the slice of the collection repository this adapter needs.
type Catalog interface {
	GetCollection(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error)
	SetCollectionCover(ctx context.Context, id, cover string) error
}

// Repo bridges the collection catalog to covergen.Repo.
type Repo struct {
	Catalog Catalog
}

func (r Repo) CoverSubject(ctx context.Context, id, language string) (covergen.Subject, bool, error) {
	c, _, ok, err := r.Catalog.GetCollection(ctx, id)
	if err != nil || !ok {
		return covergen.Subject{}, ok, err
	}
	name, desc := pickLocale(c, language)
	return covergen.Subject{Name: name, Desc: desc}, true, nil
}

func (r Repo) SetCover(ctx context.Context, id, key string) error {
	return r.Catalog.SetCollectionCover(ctx, id, key)
}

func pickLocale(c catalog.Collection, language string) (name, desc string) {
	for _, l := range []string{language, "en"} {
		if l == "" {
			continue
		}
		if n, ok := c.Names[l]; ok && n != "" {
			return n, c.Descriptions[l]
		}
	}
	for l, n := range c.Names {
		return n, c.Descriptions[l]
	}
	return "", ""
}
