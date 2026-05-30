// Package configdoc owns the on-disk
// `<OutDir>/artifacts/catalog/config.json` — the local source-of-truth for
// the human-edited sections of the published public/config.json:
//
//	{ "regions": [ ...CdnServer... ], "proactive": { ...rules/holidays... } }
//
// CRUD tools (catalog.config.regions.*, catalog.proactive.*) edit this file
// but do NOT touch S3 — publishing is a separate step:
//
//   - catalog.config.publish  → push these sections to S3 config.json only
//     (no DB, no version bump).
//   - catalog.publish         → DB + everything, including these sections.
//
// The file is parsed/serialized through map[string]any so unknown / forward-
// compatible keys survive round-trips (a strict struct would drop them).
package configdoc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Store reads/writes the local config.json. Mu is shared with the catalog
// publishers so concurrent edits + publishes never interleave on the file.
type Store struct {
	OutDir string
	Mu     *sync.Mutex
}

// Path is the on-disk location of the local config document.
func (s Store) Path() string {
	return filepath.Join(s.OutDir, "artifacts", "catalog", "config.json")
}

// Load parses config.json into a generic map. Returns (nil, false, nil) when
// the file does not exist.
func (s Store) Load() (map[string]any, bool, error) {
	raw, err := os.ReadFile(s.Path())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, false, fmt.Errorf("decode config.json: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	return m, true, nil
}

// Save writes doc atomically via tmp+rename (mirrors the proactive/meta
// convention). Two-space indent matches the other catalog artifacts.
func (s Store) Save(doc map[string]any) (string, error) {
	path := s.Path()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("mkdir: %w", err)
	}
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode: %w", err)
	}
	body = append(body, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	return path, nil
}

// Section returns the raw JSON of one top-level key (e.g. "regions",
// "proactive"), and whether it was present. Useful for publishers that copy
// sections into the S3 config without re-typing them.
func (s Store) Section(key string) (json.RawMessage, bool, error) {
	doc, ok, err := s.Load()
	if err != nil || !ok {
		return nil, false, err
	}
	raw, present := doc[key]
	if !present {
		return nil, false, nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}
