// Package fsbatchstore keeps review batch job records on disk between submit
// and collect, which may be hours and a daemon restart apart.
package fsbatchstore

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/review"
)

type Store struct {
	Dir string
}

func New(outDir string) *Store {
	return &Store{Dir: filepath.Join(outDir, "artifacts", "lake", "batches")}
}

// fileName flattens the job name, which arrives as "batches/xyz".
func (s *Store) fileName(name string) string {
	safe := strings.ReplaceAll(strings.TrimPrefix(name, "batches/"), "/", "_")
	return filepath.Join(s.Dir, safe+".json")
}

func (s *Store) Save(ctx context.Context, rec review.BatchRecord) error {
	if rec.Name == "" {
		return fmt.Errorf("batch store: record without a job name")
	}
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	path := s.fileName(rec.Name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) Load(ctx context.Context, name string) (review.BatchRecord, error) {
	body, err := os.ReadFile(s.fileName(name))
	if err != nil {
		return review.BatchRecord{}, fmt.Errorf("batch store: no record for job %q: %w", name, err)
	}
	var rec review.BatchRecord
	if err := json.Unmarshal(body, &rec); err != nil {
		return review.BatchRecord{}, fmt.Errorf("batch store: record for %q is unreadable: %w", name, err)
	}
	return rec, nil
}

func (s *Store) List(ctx context.Context) ([]review.BatchRecord, error) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []review.BatchRecord
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(s.Dir, e.Name()))
		if err != nil {
			continue
		}
		var rec review.BatchRecord
		if json.Unmarshal(body, &rec) == nil && rec.Name != "" {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SubmittedAt.After(out[j].SubmittedAt) })
	return out, nil
}

var _ review.BatchStore = (*Store)(nil)
