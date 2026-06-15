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
	"fmt"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	fsartifact "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/infra/artifact/fs"
)

type Store struct{ art *fsartifact.Writer }

func New(art *fsartifact.Writer) *Store { return &Store{art: art} }

func (s *Store) granularKey(id track.Id, lang string) string {
	return fmt.Sprintf("artifacts/tracks/%s/outline/%s/granular.json", string(id), lang)
}

// WriteGranularOutline writes the fine heading list for one (track, language)
// to the lake and uploads it to S3 in one call.
func (s *Store) WriteGranularOutline(ctx context.Context, id track.Id, language string, granularJSON []byte) error {
	return s.art.Write(ctx, s.granularKey(id, language), granularJSON)
}
