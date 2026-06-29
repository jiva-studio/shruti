// Package registeraudio records ALREADY-existing audio files (any kind) into
// the catalog as track_audio rows, WITHOUT any processing. It exists because
// some versions are produced out-of-band — e.g. the batch denoiser writes
// clean.mp3 straight to S3 — and only the catalog row is missing. It reuses the
// generic UpsertAudios (keyed by kind), so it's not tied to any one kind, and
// registers the whole batch in a single transaction.
package registeraudio

import (
	"context"
	"fmt"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/catalog"
)

type UseCase struct {
	Catalog catalogport.CommitRepository
}

// Item is one (track, language, kind) registration. SizeBytes/DurationMs are
// optional; when <= 0 they default to the variant's existing 'original' row.
type Item struct {
	TrackID    string `json:"track_id"`
	Language   string `json:"language"`
	Kind       string `json:"kind"`
	SizeBytes  int64  `json:"size_bytes"`
	DurationMs int64  `json:"duration_ms"`
}

type Result struct {
	Registered int      `json:"registered"`
	Skipped    int      `json:"skipped"`
	Errors     []string `json:"errors,omitempty"`
}

// RunBulk builds a track_audio row per item (path = canonical
// public/tracks/{id}/audio/{kind}.mp3) and upserts them all in one
// transaction. Items missing size/duration are filled from the variant's
// 'original' row (a denoised/edited version has the same length as the source).
// Idempotent.
func (uc UseCase) RunBulk(ctx context.Context, items []Item) (Result, error) {
	res := Result{}
	rows := make([]catalog.AudioRow, 0, len(items))
	for _, it := range items {
		if it.TrackID == "" || it.Language == "" || it.Kind == "" {
			res.Skipped++
			res.Errors = append(res.Errors, fmt.Sprintf("skip: missing track_id/language/kind (%s)", it.TrackID))
			continue
		}
		size, dur := it.SizeBytes, it.DurationMs
		if size <= 0 || dur <= 0 {
			orig, err := uc.Catalog.GetAudios(ctx, it.TrackID, it.Language)
			if err == nil {
				for _, r := range orig {
					if r.Kind == catalog.AudioKindOriginal {
						if dur <= 0 {
							dur = r.Duration
						}
						if size <= 0 {
							size = r.Filesize
						}
					}
				}
			}
		}
		rows = append(rows, catalog.AudioRow{
			TrackID:  it.TrackID,
			Language: it.Language,
			Kind:     it.Kind,
			Path:     fmt.Sprintf("public/tracks/%s/audio/%s.mp3", it.TrackID, it.Kind),
			Filesize: size,
			Duration: dur,
		})
	}
	if err := uc.Catalog.UpsertAudios(ctx, rows); err != nil {
		return res, err
	}
	res.Registered = len(rows)
	return res, nil
}
