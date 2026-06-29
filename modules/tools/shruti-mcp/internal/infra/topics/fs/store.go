// Package fstopics persists the topic vocabulary centroids as a private
// artifact (artifacts/topics/centroids.json) — lake + S3 mirror, never in
// current.db. topics.build writes it; track.topics.assign reads it.
package fstopics

import (
	"context"
	"encoding/json"
	"fmt"

	domaintopics "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/topics"
	fsartifact "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/artifact/fs"
)

const centroidsKey = "artifacts/topics/centroids.json"

type Store struct{ art *fsartifact.Writer }

func New(art *fsartifact.Writer) *Store { return &Store{art: art} }

// WriteVocabulary persists the centroids to the lake and uploads to S3.
func (s *Store) WriteVocabulary(ctx context.Context, v domaintopics.Vocabulary) error {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal vocabulary: %w", err)
	}
	return s.art.Write(ctx, centroidsKey, body)
}

// ReadVocabulary loads the centroids from the lake. Returns os.ErrNotExist when
// topics.build hasn't run yet (assign surfaces a clear "build topics first").
func (s *Store) ReadVocabulary() (domaintopics.Vocabulary, error) {
	body, err := s.art.Read(centroidsKey)
	if err != nil {
		return domaintopics.Vocabulary{}, err
	}
	var v domaintopics.Vocabulary
	if err := json.Unmarshal(body, &v); err != nil {
		return domaintopics.Vocabulary{}, fmt.Errorf("parse vocabulary: %w", err)
	}
	return v, nil
}
