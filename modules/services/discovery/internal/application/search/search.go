// Package search answers "which recordings are about this".
//
// Two lanes run over the same chunks — vector similarity and lexical match —
// and their rankings are fused. Meaning alone misses an exact reference
// someone typed; words alone miss a paraphrase.
package search

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

type Service struct {
	Index    Index
	Embedder Embedder
}

// Query is free text plus the structured filters that narrow it.
//
// The narrowing fields are lists because that is how they are asked: a person
// choosing speakers in an interface ticks several, and one of them silently
// winning is not an answer to what they asked.
type Query struct {
	Text    string
	Authors []string
	// AuthorIDs are the people Authors resolved to, filled in before the query
	// runs so the filter can be an indexed equality rather than a text match.
	AuthorIDs []int64
	Languages []string
	// Sources are scriptures — BG, SB, CC_MADHYA — which is what a source is in
	// this corpus and in the client. Which archive a recording was found in is
	// not something anybody searches by.
	Sources []string
	// Tokens is a coordinate within those scriptures: "2.13".
	Tokens string
	// Collection narrows to one cycle, by id or by name.
	Collection string
	DateFrom   *time.Time
	DateTo     *time.Time
	Limit      int
	Offset     int
	// Vector is the query already embedded. Set it to skip the round trip — the
	// caller may have started it before it knew the rest of the filter.
	Vector []float32
}

// filter is the part of the query the index narrows by.
func (q Query) filter() domain.SearchFilter {
	return domain.SearchFilter{
		AuthorIDs:  q.AuthorIDs,
		Languages:  q.Languages,
		Sources:    q.Sources,
		Tokens:     q.Tokens,
		Collection: q.Collection,
		DateFrom:   q.DateFrom,
		DateTo:     q.DateTo,
	}
}

// candidates is how deep each lane goes before fusing. Wider than the page so
// fusion has something to work with.
const candidates = 60

// noAuthor stands in when a name matches nobody, so the search returns nothing
// rather than dropping the filter.
const noAuthor = -1

func (s *Service) prepare(ctx context.Context, q *Query) error {
	// A scripture is asked for by name as often as by code: "Бхагавад-гита" and
	// "BG" are one book, and only one of them is what the column holds.
	for i, name := range q.Sources {
		if domain.Addressable(name) {
			continue
		}
		if src, ok := domain.SourceByName(name); ok {
			q.Sources[i] = src.Code
		}
	}
	if len(q.Authors) == 0 || len(q.AuthorIDs) > 0 {
		return nil
	}
	seen := map[int64]bool{}
	for _, name := range q.Authors {
		if strings.TrimSpace(name) == "" {
			continue
		}
		ids, err := s.Index.ResolveAuthors(ctx, name)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if !seen[id] {
				seen[id] = true
				q.AuthorIDs = append(q.AuthorIDs, id)
			}
		}
	}
	// Every name given matched nobody, which is an empty answer rather than an
	// unfiltered one.
	if len(q.AuthorIDs) == 0 {
		q.AuthorIDs = []int64{noAuthor}
	}
	return nil
}

// Search runs both lanes and fuses them. A query with no text is answered by
// its filters alone.
func (s *Service) Search(ctx context.Context, q Query) ([]Hit, error) {
	if q.Limit <= 0 || q.Limit > 100 {
		q.Limit = 20
	}
	if err := s.prepare(ctx, &q); err != nil {
		return nil, err
	}
	f := q.filter()
	if strings.TrimSpace(q.Text) == "" {
		found, err := s.Index.Filtered(ctx, f, q.Limit, q.Offset)
		if err != nil {
			return nil, err
		}
		return hitsFrom(found), nil
	}

	var vector []domain.Hit
	if v := q.Vector; len(v) > 0 {
		var err error
		if vector, err = s.Index.Nearest(ctx, f, v, candidates); err != nil {
			return nil, err
		}
	} else if s.Embedder != nil {
		vecs, err := s.Embedder.Embed(ctx, []string{q.Text})
		if err != nil {
			return nil, fmt.Errorf("embed query: %w", err)
		}
		if vector, err = s.Index.Nearest(ctx, f, vecs[0], candidates); err != nil {
			return nil, err
		}
	}
	lexical, err := s.lexical(ctx, f, q.Text)
	if err != nil {
		return nil, err
	}
	return hitsFrom(fuse(q, vector, lexical)), nil
}

// lexical matches the words themselves.
//
// A sentence is asked for whole first, then loosened once. Requiring every
// word finds the exact talk when it exists; requiring any of them, ranked by
// how many matched, finds something when it does not. One step, not a cascade
// — a search that quietly drops half a question cannot explain itself.
func (s *Service) lexical(ctx context.Context, f domain.SearchFilter, text string) ([]domain.Hit, error) {
	hits, err := s.Index.AllWords(ctx, f, text, candidates)
	if err != nil || len(hits) > 0 {
		return hits, err
	}
	return s.Index.AnyWord(ctx, f, text, candidates)
}
