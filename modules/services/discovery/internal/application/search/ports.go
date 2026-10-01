package search

import (
	"context"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// Embedder turns the query into a vector.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
}

// Index is the searchable corpus.
//
// Every lane leaves out a recording whose file the archive stopped offering.
// Nearest ranks by distance to the vector, AllWords by how well a chunk
// matches the whole text and AnyWord by how much of it a chunk holds; each
// goes limit deep. Filtered orders by place in a cycle, then newest first.
type Index interface {
	ResolveAuthors(ctx context.Context, name string) ([]int64, error)
	SpeakersNamed(ctx context.Context, spellings, folded []string) ([]domain.Speaker, error)
	Nearest(ctx context.Context, f domain.SearchFilter, vec []float32, limit int) ([]domain.Hit, error)
	AllWords(ctx context.Context, f domain.SearchFilter, text, langConfig string, limit int) ([]domain.Hit, error)
	AnyWord(ctx context.Context, f domain.SearchFilter, text, langConfig string, limit int) ([]domain.Hit, error)
	Filtered(ctx context.Context, f domain.SearchFilter, limit, offset int) ([]domain.Hit, error)
}
