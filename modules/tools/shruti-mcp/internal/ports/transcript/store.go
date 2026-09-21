// Package transcriptport defines the port for transcript artifact storage.
package transcriptport

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// Store owns the on-disk paths for transcript artifacts under out/.
//
//	raw       → out/artifacts/tracks/{id}/transcripts/{lang}/raw.json
//	review    → out/artifacts/tracks/{id}/transcripts/{lang}/review.json
//	chunk     → out/artifacts/tracks/{id}/transcripts/{lang}/chunk_{NNNN}.json
//	reviewed  → out/public/tracks/{id}/transcripts/{lang}.json   (the public one)
type Store interface {
	WriteRaw(ctx context.Context, id track.ID, language string, raw transcript.Raw) error
	ReadRaw(ctx context.Context, id track.ID, language string) (transcript.Raw, error)

	WriteReviewSession(ctx context.Context, id track.ID, language string, sessionJSON []byte) error

	// ReadReviewSession returns the review.json bytes for one
	// (track, language) or (nil, os.ErrNotExist) when no review session
	// has been recorded yet. Used by the audit tools to walk per-track
	// metrics across the corpus.
	ReadReviewSession(ctx context.Context, id track.ID, language string) ([]byte, error)

	// WriteReviewChunk persists one chunk's request+response pair for audit/debug.
	// Path: artifacts/tracks/{id}/transcripts/{lang}/chunk_{NNNN}.json (zero-padded).
	WriteReviewChunk(ctx context.Context, id track.ID, language string, chunkIndex int, chunkJSON []byte) error

	// ReadReviewChunk returns the chunk artifact bytes if present, or
	// (nil, os.ErrNotExist) if not. Used by transcript_review's resume
	// path to skip already-succeeded chunks.
	ReadReviewChunk(ctx context.Context, id track.ID, language string, chunkIndex int) ([]byte, error)

	WriteReviewed(ctx context.Context, t transcript.Reviewed) error

	// ReadReviewed reads back the public reviewed transcript for one
	// (track, language). Returns (zero, os.ErrNotExist) when no file is
	// on disk yet. Used by commit to enforce the non-empty-blocks invariant
	// before writing to current.db.
	ReadReviewed(ctx context.Context, id track.ID, language string) (transcript.Reviewed, error)

	// PublicTranscriptPath returns the rsync-bound key (no leading slash):
	//   public/tracks/{id}/transcripts/{lang}.json
	PublicTranscriptKey(id track.ID, language string) string
}
