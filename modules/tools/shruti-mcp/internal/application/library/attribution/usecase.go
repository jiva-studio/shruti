// Package attribution is the application use case for library.attribution.*
// MCP tools. Mints attribution IDs, validates inputs, and orchestrates
// auto-translation on create so the curator only needs to enter one text in
// one language to populate every supported locale.
package attribution

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/library"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/ids"
	libraryport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/library"
)

const idPrefix = "attribution_"

// UseCase wraps the attribution repo + translator. Other than Create's
// auto-translate side-effect, methods are thin pass-throughs that exist so
// MCP tool handlers don't import the infra package directly.
type UseCase struct {
	Repo       libraryport.AttributionRepository
	Translator libraryport.AttributionTranslator // optional; nil disables auto-translate
	Minter     ids.Minter
	Langs      []string // supported locales from settings (e.g. ["ru","en"])
}

// Create mints `attribution_<nanoid>`, inserts the row with the first text
// variant, then (best-effort) auto-translates that text into each other
// supported language. Translation failures are logged and ignored — the
// attribution is still created with the source-language text.
//
// Idempotent: if an attribution of the same kind already has this exact
// (sourceLang, sourceText) variant, its id is returned and nothing is
// created. This lets a bulk import (or a retried single create) re-run
// safely without minting duplicates — no external checkpoint needed.
func (uc UseCase) Create(ctx context.Context, kind library.AttributionKind, sourceLang, sourceText string) (string, error) {
	if sourceText == "" {
		return "", fmt.Errorf("create attribution: text required")
	}
	if sourceLang == "" {
		return "", fmt.Errorf("create attribution: language required")
	}
	if kind != library.AttrPinned && kind != library.AttrBoost {
		return "", fmt.Errorf("create attribution: invalid kind %q", kind)
	}
	if existing, found, err := uc.Repo.AttributionFindByText(ctx, kind, sourceLang, sourceText); err != nil {
		return "", err
	} else if found {
		return existing, nil
	}
	id := idPrefix + uc.Minter.MintTail()
	if err := uc.Repo.AttributionCreate(ctx, id, kind, sourceLang, sourceText); err != nil {
		return "", err
	}

	if uc.Translator == nil {
		return id, nil
	}
	for _, lang := range uc.Langs {
		if lang == sourceLang {
			continue
		}
		translated, err := uc.Translator.Translate(ctx, sourceText, sourceLang, lang, kind)
		if err != nil {
			slog.WarnContext(ctx, "attribution auto-translate failed",
				"attribution_id", id, "from", sourceLang, "to", lang, "err", err)
			continue
		}
		if translated == "" || translated == sourceText {
			continue
		}
		if err := uc.Repo.AttributionTextAdd(ctx, id, lang, translated); err != nil {
			slog.WarnContext(ctx, "attribution auto-translate insert failed",
				"attribution_id", id, "to", lang, "err", err)
		}
	}
	return id, nil
}

func (uc UseCase) Get(ctx context.Context, id string) (library.Attribution, bool, error) {
	return uc.Repo.AttributionGet(ctx, id)
}

func (uc UseCase) List(ctx context.Context, opts library.ListAttributionsOpts) ([]library.Attribution, error) {
	return uc.Repo.AttributionList(ctx, opts)
}

func (uc UseCase) TextAdd(ctx context.Context, id, language, text string) error {
	if id == "" || language == "" || text == "" {
		return fmt.Errorf("text_add: id, language, text required")
	}
	return uc.Repo.AttributionTextAdd(ctx, id, language, text)
}

func (uc UseCase) TextRemove(ctx context.Context, id, language, text string) error {
	if id == "" || language == "" || text == "" {
		return fmt.Errorf("text_remove: id, language, text required")
	}
	return uc.Repo.AttributionTextRemove(ctx, id, language, text)
}

func (uc UseCase) RefAdd(ctx context.Context, id string, ref library.AttributionRef) error {
	return uc.Repo.AttributionRefAdd(ctx, id, ref)
}

func (uc UseCase) RefRemove(ctx context.Context, id string, ref library.AttributionRef) error {
	return uc.Repo.AttributionRefRemove(ctx, id, ref)
}

func (uc UseCase) Delete(ctx context.Context, id string) error {
	return uc.Repo.AttributionDelete(ctx, id)
}
