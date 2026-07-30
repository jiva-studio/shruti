// Package openaicompatmeta adapts the shared pipeline metadata extractor
// (pipeline/metadata/openaicompat) into mcp's metaport.Extractor: it maps the
// source-agnostic metadata.Extracted onto mcp's immutable track.Metadata,
// preserving the domain invariants that NewMetadata enforces (kind whitelist,
// reference validation). The LLM call + prompts now live in the shared lib.
package openaicompatmeta

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	metaport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/metadata"
	sharedmeta "github.com/jiva-studio/shruti/pipeline/metadata/openaicompat"
)

// ProviderName is re-exported so wiring/logging keeps the same identifier.
const ProviderName = sharedmeta.ProviderName

// Config mirrors the shared extractor's config; aliased so existing wiring
// (openaicompatmeta.Config{...}) is unchanged.
type Config = sharedmeta.Config

// Extractor wraps the shared extractor and maps its result into track.Metadata.
type Extractor struct {
	inner *sharedmeta.Extractor
}

func New(cfg Config) (*Extractor, error) {
	inner, err := sharedmeta.New(cfg)
	if err != nil {
		return nil, err
	}
	return &Extractor{inner: inner}, nil
}

func (e *Extractor) Name() string { return e.inner.Name() }

func (e *Extractor) Extract(ctx context.Context, relPath string, sourceCodes []string) (track.Metadata, error) {
	ex, err := e.inner.Extract(ctx, relPath, sourceCodes)
	if err != nil {
		return track.Metadata{}, err
	}
	refs := make([]track.RefRaw, 0, len(ex.References))
	for _, r := range ex.References {
		refs = append(refs, track.RefRaw{SourceCode: r.SourceCode, Tokens: r.Tokens})
	}
	return track.NewMetadata(track.MetadataSpec{
		Date:            ex.Date,
		AuthorRaw:       ex.AuthorRaw,
		LocationRaw:     ex.LocationRaw,
		Title:           ex.Title,
		TitleIsFallback: ex.TitleIsFallback,
		Languages:       ex.Languages,
		References:      refs,
		KindTag:         ex.KindTag,
	})
}

var _ metaport.Extractor = (*Extractor)(nil)
