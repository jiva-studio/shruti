package audio

import (
	"context"
	"io"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
)

// Store owns the on-disk paths for audio under out/.
type Store interface {
	// SourceArtifactPath returns out/artifacts/tracks/{id}/audio/source.mp3.
	SourceArtifactPath(id track.Id) string

	// PublicAudioPath returns out/public/tracks/{id}/audio/original.mp3.
	PublicAudioPath(id track.Id) string

	// MoveSourceFromInput consumes the source mp3 at srcPath into
	// SourceArtifactPath. Same-filesystem case is a free os.Rename;
	// cross-device falls back to copy-then-remove. Caller must not
	// expect the input file to exist after this returns.
	MoveSourceFromInput(ctx context.Context, id track.Id, srcPath string) error

	// AdoptSiblingPDF moves the dedup-tool's typeset transcript PDF that
	// ships next to the mp3 (same basename, .pdf extension) into
	// out/artifacts/tracks/{id}/transcript.pdf. Returns adopted=true if a
	// PDF was found and moved, false if no sibling exists. No-op when the
	// destination already has a PDF (idempotent on re-ingest).
	AdoptSiblingPDF(ctx context.Context, id track.Id, mp3SrcPath string) (adopted bool, err error)

	// AtomicWritePublic writes bytes to PublicAudioPath via tmp + rename.
	AtomicWritePublic(ctx context.Context, id track.Id, src io.Reader) error
}

// Probe extracts duration / bitrate / size from an mp3 file (ffprobe).
type Probe interface {
	Probe(ctx context.Context, path string) (Info, error)
}

type Info struct {
	DurationMs int64
	Bitrate    int // kbps
	SizeBytes  int64
	Channels   int
	SampleRate int
}
