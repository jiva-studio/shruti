package search

import (
	"context"
	"strings"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// SpeakersNamed finds who the corpus knows under any of these spellings.
//
// The spellings come folded, so a name is found past its alphabet; the counts
// come back with them because whether a word is a name at all is a question
// about this corpus and not about language.
func (s *Service) SpeakersNamed(ctx context.Context, spellings, folded []string) ([]domain.Speaker, error) {
	if len(spellings) == 0 {
		return nil, nil
	}
	return s.Index.SpeakersNamed(ctx, spellings, folded)
}

// Names reports whether an author filter can match anybody at all.
//
// It exists so an empty result can say which of the two empties it is. "Nothing
// matches" is an answer about the corpus; "nothing could match" is an answer
// about the question, and a caller shown a bare empty list has no way to tell
// them apart.
func (s *Service) Names(ctx context.Context, author string) (bool, error) {
	if strings.TrimSpace(author) == "" {
		return true, nil
	}
	ids, err := s.Index.ResolveAuthors(ctx, author)
	if err != nil {
		return false, err
	}
	return len(ids) > 0, nil
}
