// Package dicttranslate produces canonical localized names for a brand-new
// dict entry. It is consulted only at auto-create time in extractmeta — when
// the resolver chain finds no match for a raw author/location/source string,
// the auto-create branch asks the translator for the corresponding name in
// every other language we serve, so the entry is born with both ru and en
// rows and the next file in the alternate language can exact-match it.
package dicttranslate

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

type Translator interface {
	// Translate returns localized names for `query` (which is in `fromLang`).
	// Names always contains fromLang→query; the implementation fills in the
	// other languages it knows about. For Kind == KindSource, ShortNames is
	// populated with the abbreviation form; otherwise it is nil.
	Translate(ctx context.Context, kind catalog.Kind, query, fromLang string) (Result, error)
}

type Result struct {
	Names      map[string]string
	ShortNames map[string]string // populated only when Kind == KindSource
}
