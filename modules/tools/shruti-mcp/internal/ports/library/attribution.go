// Package libraryport defines the application-layer ports for library-side
// repositories. Infra packages (sqlite, gitabase importer, ...) implement
// these; the application/usecase packages depend only on the interfaces.
package libraryport

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

// AttributionRepository covers CRUD for the library_attribution* tables.
// Application layer mints IDs externally and passes them in.
type AttributionRepository interface {
	AttributionCreate(ctx context.Context, id string, kind library.AttributionKind, language, firstText string) error
	AttributionGet(ctx context.Context, id string) (library.Attribution, bool, error)
	AttributionList(ctx context.Context, opts library.ListAttributionsOpts) ([]library.Attribution, error)
	AttributionTextAdd(ctx context.Context, id, language, text string) error
	AttributionTextRemove(ctx context.Context, id, language, text string) error
	AttributionRefAdd(ctx context.Context, id string, ref library.AttributionRef) error
	AttributionRefRemove(ctx context.Context, id string, ref library.AttributionRef) error
	AttributionDelete(ctx context.Context, id string) error
}

// AttributionTranslator produces a translation of one attribution text from
// `fromLang` to `toLang`. Implementations wrap an LLM call (Flash-Lite via
// OpenRouter). The `kind` parameter selects the prompt — question phrasings
// translate one way (preserve depth), topic labels another (keep short).
type AttributionTranslator interface {
	Translate(ctx context.Context, text, fromLang, toLang string, kind library.AttributionKind) (string, error)
}
