package sqlitecatalog

import (
	"context"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// TranscriptVariants lists every variant that points at a published
// transcript, without hashes.
func (r *Repo) TranscriptVariants(ctx context.Context) ([]catalog.TranscriptAsset, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT transcript_path, track_id, language FROM track_variants
		WHERE transcript_path IS NOT NULL AND transcript_path <> ''
		ORDER BY track_id, language`)
	if err != nil {
		return nil, fmt.Errorf("list transcript variants: %w", err)
	}
	defer rows.Close()
	var out []catalog.TranscriptAsset
	for rows.Next() {
		var a catalog.TranscriptAsset
		if err := rows.Scan(&a.Path, &a.TrackID, &a.Language); err != nil {
			return nil, fmt.Errorf("scan transcript variant: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UpsertTranscriptHashes records the transcripts' hashes in asset_hashes in
// one transaction.
func (r *Repo) UpsertTranscriptHashes(ctx context.Context, assets []catalog.TranscriptAsset) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, a := range assets {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO asset_hashes (path, sha256, track_id, language, kind)
			VALUES (?, ?, ?, ?, 'transcript')
			ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, track_id = excluded.track_id,
				language = excluded.language, kind = excluded.kind`,
			a.Path, a.SHA256, a.TrackID, a.Language); err != nil {
			return fmt.Errorf("upsert asset hash %s: %w", a.Path, err)
		}
	}
	return tx.Commit()
}

func (s *Store) TranscriptVariants(ctx context.Context) ([]catalog.TranscriptAsset, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.TranscriptVariants(ctx)
}

func (s *Store) UpsertTranscriptHashes(ctx context.Context, assets []catalog.TranscriptAsset) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.UpsertTranscriptHashes(ctx, assets); err != nil {
		return err
	}
	return markModified(s.path)
}
