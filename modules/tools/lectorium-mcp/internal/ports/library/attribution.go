// Package libraryport defines the application-layer ports for library-side
// repositories. Infra packages (sqlite, gitabase importer, ...) implement
// these; the application/usecase packages depend only on the interfaces.
package libraryport

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
)

// AttributionRepository covers CRUD for the library_attribution* tables.
// Application layer mints IDs externally and passes them in.
type AttributionRepository interface {
	AttributionCreate(ctx context.Context, id string, kind library.AttributionKind, language, firstText string) error
	// AttributionFindByText returns the id of an attribution of `kind` that
	// already has the exact (language, text) variant, or ("", false). Backs
	// idempotent Create.
	AttributionFindByText(ctx context.Context, kind library.AttributionKind, language, text string) (string, bool, error)
	AttributionGet(ctx context.Context, id string) (library.Attribution, bool, error)
	AttributionList(ctx context.Context, opts library.ListAttributionsOpts) ([]library.Attribution, error)
	AttributionTextAdd(ctx context.Context, id, language, text string) error
	AttributionTextRemove(ctx context.Context, id, language, text string) error
	AttributionNoteSet(ctx context.Context, id, language, note string) error
	AttributionNoteRemove(ctx context.Context, id, language string) error
	AttributionRefAdd(ctx context.Context, id string, ref library.AttributionRef) error
	AttributionRefRemove(ctx context.Context, id string, ref library.AttributionRef) error
	AttributionDelete(ctx context.Context, id string) error
}

// AttributionTranslator produces a translation of one attribution text from
// `fromLang` to `toLang`. Implementations wrap an LLM call (Flash-Lite via
// OpenRouter). The `kind` parameter selects the prompt — pinned (query)
// phrasings translate one way (preserve depth), boost (topical) labels
// another (keep short).
type AttributionTranslator interface {
	Translate(ctx context.Context, text, fromLang, toLang string, kind library.AttributionKind) (string, error)
}
