package metadata

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
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
