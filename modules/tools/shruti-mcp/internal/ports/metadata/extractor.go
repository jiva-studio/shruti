// Package metadata defines the port for extracting track metadata.
package metadata

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

type Extractor interface {
	Name() string
	// Extract parses a path (relative to the lake root) into a Metadata record.
	// relPath includes parent directory names so the extractor can use folder
	// context as a hint (e.g. an author-named folder like "Лекции Прабхупады"
	// strongly implies the author when the basename omits it).
	// SourceCodes is an optional list of known scripture short_names to hint
	// the extractor (e.g. ["BG", "SB", "CC"]) — improves reference parsing.
	Extract(ctx context.Context, relPath string, sourceCodes []string) (track.Metadata, error)
}

// Reader returns metadata an importer stored in a file next to the audio,
// already normalized — no filename grammar, no LLM. Stages read it directly:
// ingest for the language it records on the file row, the metadata stage for
// the full record.
type Reader interface {
	// Read takes the audio path as the caller sees it and returns the
	// importer's record. ok=false means there is no metadata file for that
	// path, which is not an error — the caller falls back to its own
	// derivation.
	Read(path string) (md track.Metadata, ok bool, err error)
}
