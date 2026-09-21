// Package fsoutline persists the private, offline-only granular outline
// artifact (the fine pre-collapse heading list the generator would otherwise
// discard) for the topic-vocabulary pipeline. It is a thin adapter over the
// shared artifact writer — lake + immediate S3 under the private artifacts/
// prefix — and is NEVER published to the client catalog:
//
//	artifacts/tracks/{id}/outline/{lang}/granular.json
//
// The published coarse outline lives in track_variants.outline (current.db).
package fsoutline

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	fsartifact "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/artifact/fs"
	outlineport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/outline"
)

type Store struct{ art *fsartifact.Writer }

func New(art *fsartifact.Writer) *Store { return &Store{art: art} }

func (s *Store) granularKey(id track.ID, lang string) string {
	return fmt.Sprintf("artifacts/tracks/%s/outline/%s/granular.json", string(id), lang)
}

// WriteGranularOutline writes the fine heading list for one (track, language)
// to the lake and uploads it to S3 in one call.
func (s *Store) WriteGranularOutline(ctx context.Context, id track.ID, language string, granularJSON []byte) error {
	return s.art.Write(ctx, s.granularKey(id, language), granularJSON)
}

// ReadGranularOutline reads back the fine heading list for one (track,
// language) from the lake. Returns os.ErrNotExist when the track has no
// granular artifact (e.g. its outline predates granular capture) — the topic
// build/assign skips such tracks.
func (s *Store) ReadGranularOutline(ctx context.Context, id track.ID, language string) ([]outlineport.GranularEntry, error) {
	body, err := s.art.Read(s.granularKey(id, language))
	if err != nil {
		return nil, err
	}
	var entries []outlineport.GranularEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("parse granular outline %s/%s: %w", id, language, err)
	}
	return entries, nil
}

// ListGranular walks the lake for every granular outline artifact and returns
// one ref per (track, language). Used by topics.build to gather the whole
// corpus. Order is deterministic (sorted by track then language).
func (s *Store) ListGranular(ctx context.Context) ([]outlineport.GranularRef, error) {
	// artifacts/tracks/<id>/outline/<lang>/granular.json
	glob := filepath.Join(s.art.OutDir, "artifacts", "tracks", "*", "outline", "*", "granular.json")
	matches, err := filepath.Glob(glob)
	if err != nil {
		return nil, err
	}
	refs := make([]outlineport.GranularRef, 0, len(matches))
	for _, m := range matches {
		// .../<id>/outline/<lang>/granular.json
		langDir := filepath.Dir(m)                   // .../<id>/outline/<lang>
		lang := filepath.Base(langDir)               // <lang>
		idDir := filepath.Dir(filepath.Dir(langDir)) // .../<id>
		id := filepath.Base(idDir)                   // <id>
		refs = append(refs, outlineport.GranularRef{TrackID: track.ID(id), Language: lang})
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].TrackID != refs[j].TrackID {
			return refs[i].TrackID < refs[j].TrackID
		}
		return refs[i].Language < refs[j].Language
	})
	return refs, nil
}
