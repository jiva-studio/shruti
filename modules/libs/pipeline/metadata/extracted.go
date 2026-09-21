// Package metadata is the shared, source-agnostic result of extracting a
// lecture's metadata from its filename/title (and, later, its transcript):
// date, author, location, title, languages, scripture references, kind tag.
//
// It is the DOMAIN shape both ingest paths speak — the shruti-mcp corpus
// pipeline and the personal-library ingest worker. Neither the raw→catalog
// resolution (dictionary ids) nor any module-specific invariants live here;
// each module maps `Extracted` into its own type (mcp's immutable
// track.Metadata, ingest's TrackDraft) and resolves separately. Pure,
// stdlib-only.
package metadata

import (
	"context"
	"time"
)

// Ref is one raw scripture reference — a source code plus its dot-joined
// tokens (e.g. {"SB", "5.5.3"}), before catalog resolution.
type Ref struct {
	SourceCode string
	Tokens     string
}

// Extracted is the raw, unresolved metadata read off a source. Date is nil
// when none was found; Title falls back to a cleaned filename with
// TitleIsFallback set so callers can flag low-confidence titles.
type Extracted struct {
	Date            *time.Time
	AuthorRaw       string
	LocationRaw     string
	Title           string
	TitleIsFallback bool
	Languages       []string
	References      []Ref
	KindTag         string
}

// Extractor turns a source path (relative to the lake root) plus the set of
// known source codes into raw metadata. Implementations live in the adapter
// ring (e.g. metadata/openaicompat over an LLM).
type Extractor interface {
	Extract(ctx context.Context, relPath string, sourceCodes []string) (Extracted, error)
}
