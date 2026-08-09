// Package fstopics persists the topic vocabulary centroids as private artifacts
// (artifacts/topics/centroids.<date>.json) — lake + S3 mirror, never in
// current.db. topics.build writes one per build; track.topics.assign reads the
// newest.
package fstopics

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	domaintopics "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/topics"
	fsartifact "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/artifact/fs"
)

const topicsDir = "artifacts/topics"

type Store struct{ art *fsartifact.Writer }

func New(art *fsartifact.Writer) *Store { return &Store{art: art} }

// WriteVocabulary persists one dated file per build. There is no unversioned
// copy: the newest file IS the current vocabulary, so there is nothing to keep
// in step and no way for a pointer to disagree with what it points at.
//
// Every build is kept because it mints new topic ids, and the moment the old
// centroids are gone there is no way to tell what a retired topic meant — while
// every track_topics row and every generated cover still refers to those ids.
// The date is also written inside the file, so a copied vocabulary still says
// when it was made.
func (s *Store) WriteVocabulary(ctx context.Context, v domaintopics.Vocabulary) error {
	if v.BuiltAt.IsZero() {
		v.BuiltAt = time.Now().UTC()
	}
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal vocabulary: %w", err)
	}
	key := fmt.Sprintf("%s/centroids.%s.json", topicsDir, v.BuiltAt.Format("20060102-150405"))
	if err := s.art.Write(ctx, key, body); err != nil {
		return fmt.Errorf("write vocabulary %s: %w", key, err)
	}
	return nil
}

// ReadVocabulary loads the newest vocabulary in the lake. Returns
// os.ErrNotExist when topics.build hasn't run yet (assign surfaces a clear
// "build topics first").
//
// Newest is decided by the filename, which carries the build date in a form
// that sorts chronologically.
func (s *Store) ReadVocabulary() (domaintopics.Vocabulary, error) {
	matches, err := filepath.Glob(filepath.Join(s.art.OutDir, topicsDir, "centroids.*.json"))
	if err != nil {
		return domaintopics.Vocabulary{}, fmt.Errorf("list vocabularies: %w", err)
	}
	if len(matches) == 0 {
		return domaintopics.Vocabulary{}, fmt.Errorf("no topic vocabulary in %s: %w", topicsDir, os.ErrNotExist)
	}
	sort.Strings(matches)
	newest := matches[len(matches)-1]

	body, err := os.ReadFile(newest)
	if err != nil {
		return domaintopics.Vocabulary{}, err
	}
	var v domaintopics.Vocabulary
	if err := json.Unmarshal(body, &v); err != nil {
		return domaintopics.Vocabulary{}, fmt.Errorf("parse vocabulary %s: %w", filepath.Base(newest), err)
	}
	return v, nil
}
