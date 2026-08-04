// Package attribution is the application use case for library.attribution.*
// MCP tools. Mints attribution IDs, validates inputs, and orchestrates
// auto-translation on create so the curator only needs to enter one text in
// one language to populate every supported locale.
package attribution

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/ids"
	libraryport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/library"
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
// `note` is only meaningful for kind=memory — the long curator note set in
// `sourceLang` and (best-effort) auto-translated into every other supported
// language. Empty for pinned/boost.
func (uc UseCase) Create(ctx context.Context, kind library.AttributionKind, sourceLang, sourceText, note string) (string, error) {
	if sourceText == "" {
		return "", fmt.Errorf("create attribution: text required")
	}
	if sourceLang == "" {
		return "", fmt.Errorf("create attribution: language required")
	}
	if kind != library.AttrPinned && kind != library.AttrBoost && kind != library.AttrMemory {
		return "", fmt.Errorf("create attribution: invalid kind %q", kind)
	}
	existing, found, err := uc.Repo.AttributionFindByText(ctx, kind, sourceLang, sourceText)
	if err != nil {
		return "", err
	}
	id := existing
	if !found {
		id = idPrefix + uc.Minter.MintTail()
		if err := uc.Repo.AttributionCreate(ctx, id, kind, sourceLang, sourceText); err != nil {
			return "", err
		}
		uc.autoTranslateTriggers(ctx, id, kind, sourceLang, sourceText)
	}

	// Note handling is idempotent-safe: setting it on an existing memory
	// re-runs the set/translate (note_set is an upsert) so a retried create
	// still lands the note.
	if kind == library.AttrMemory && note != "" {
		uc.setAndTranslateNote(ctx, id, sourceLang, note)
	}
	return id, nil
}

// autoTranslateTriggers best-effort translates the source trigger text into
// every other supported language. Failures are logged, never fatal.
func (uc UseCase) autoTranslateTriggers(ctx context.Context, id string, kind library.AttributionKind, sourceLang, sourceText string) {
	if uc.Translator == nil {
		return
	}
	// A trigger is a short search phrase. For memory it's query-like, so use the
	// pinned prompt (short, register-preserving) rather than the long-note
	// memory prompt — the note itself is translated separately.
	triggerKind := kind
	if triggerKind == library.AttrMemory {
		triggerKind = library.AttrPinned
	}
	for _, lang := range uc.Langs {
		if lang == sourceLang {
			continue
		}
		translated, err := uc.Translator.Translate(ctx, sourceText, sourceLang, lang, triggerKind)
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
}

// setAndTranslateNote sets the note in sourceLang then best-effort translates
// it into every other supported language (kind=memory prompt). Failures are
// logged, never fatal. Existing translations are overwritten.
func (uc UseCase) setAndTranslateNote(ctx context.Context, id, sourceLang, note string) {
	if err := uc.Repo.AttributionNoteSet(ctx, id, sourceLang, note); err != nil {
		slog.WarnContext(ctx, "attribution note set failed", "attribution_id", id, "lang", sourceLang, "err", err)
		return
	}
	if uc.Translator == nil {
		return
	}
	for _, lang := range uc.Langs {
		if lang == sourceLang {
			continue
		}
		translated, err := uc.Translator.Translate(ctx, note, sourceLang, lang, library.AttrMemory)
		if err != nil {
			slog.WarnContext(ctx, "attribution note auto-translate failed",
				"attribution_id", id, "from", sourceLang, "to", lang, "err", err)
			continue
		}
		if translated == "" || translated == note {
			continue
		}
		if err := uc.Repo.AttributionNoteSet(ctx, id, lang, translated); err != nil {
			slog.WarnContext(ctx, "attribution note translate insert failed",
				"attribution_id", id, "to", lang, "err", err)
		}
	}
}

func (uc UseCase) Get(ctx context.Context, id string) (library.Attribution, bool, error) {
	return uc.Repo.AttributionGet(ctx, id)
}

func (uc UseCase) List(ctx context.Context, opts library.ListAttributionsOpts) ([]library.Attribution, error) {
	return uc.Repo.AttributionList(ctx, opts)
}

// TextAdd inserts one trigger variant and, unless `skipTranslate`, mirrors
// Create's behaviour by best-effort translating it into every other supported
// language. Without this a curator who grows an attribution's trigger set after
// creation silently leaves every non-source locale behind — the source-language
// triggers match, the others never do.
func (uc UseCase) TextAdd(ctx context.Context, id, language, text string, skipTranslate bool) error {
	if id == "" || language == "" || text == "" {
		return fmt.Errorf("text_add: id, language, text required")
	}
	if err := uc.Repo.AttributionTextAdd(ctx, id, language, text); err != nil {
		return err
	}
	if skipTranslate {
		return nil
	}
	attr, found, err := uc.Repo.AttributionGet(ctx, id)
	if err != nil || !found {
		// The insert landed; a missing row here only costs the translation.
		slog.WarnContext(ctx, "text_add: cannot resolve kind, skipping translate",
			"attribution_id", id, "err", err)
		return nil
	}
	uc.autoTranslateTriggers(ctx, id, attr.Kind, language, text)
	return nil
}

func (uc UseCase) TextRemove(ctx context.Context, id, language, text string) error {
	if id == "" || language == "" || text == "" {
		return fmt.Errorf("text_remove: id, language, text required")
	}
	return uc.Repo.AttributionTextRemove(ctx, id, language, text)
}

func (uc UseCase) NoteSet(ctx context.Context, id, language, note string) error {
	if id == "" || language == "" || note == "" {
		return fmt.Errorf("note_set: id, language, note required")
	}
	return uc.Repo.AttributionNoteSet(ctx, id, language, note)
}

func (uc UseCase) NoteRemove(ctx context.Context, id, language string) error {
	if id == "" || language == "" {
		return fmt.Errorf("note_remove: id, language required")
	}
	return uc.Repo.AttributionNoteRemove(ctx, id, language)
}

// NoteTranslate fills in missing `toLang` notes by translating from `fromLang`.
// If `ids` is empty it walks every memory attribution. Existing `toLang` notes
// are left untouched (never overwrites a human edit). Returns the count of
// notes written.
func (uc UseCase) NoteTranslate(ctx context.Context, fromLang, toLang string, ids []string) (int, error) {
	if fromLang == "" || toLang == "" {
		return 0, fmt.Errorf("note_translate: from and to language required")
	}
	if fromLang == toLang {
		return 0, fmt.Errorf("note_translate: from and to language must differ")
	}
	if uc.Translator == nil {
		return 0, fmt.Errorf("note_translate: translator not configured")
	}

	targets := ids
	if len(targets) == 0 {
		items, err := uc.Repo.AttributionList(ctx, library.ListAttributionsOpts{Kind: library.AttrMemory, Limit: 500})
		if err != nil {
			return 0, err
		}
		for _, it := range items {
			targets = append(targets, it.ID)
		}
	}

	written := 0
	for _, id := range targets {
		a, ok, err := uc.Repo.AttributionGet(ctx, id)
		if err != nil {
			return written, err
		}
		if !ok || a.Kind != library.AttrMemory {
			continue
		}
		src, hasSrc := a.Notes[fromLang]
		if !hasSrc || src == "" {
			continue
		}
		if _, hasDst := a.Notes[toLang]; hasDst {
			continue // never overwrite an existing translation / human edit
		}
		translated, err := uc.Translator.Translate(ctx, src, fromLang, toLang, library.AttrMemory)
		if err != nil {
			slog.WarnContext(ctx, "note_translate failed", "attribution_id", id, "to", toLang, "err", err)
			continue
		}
		if translated == "" {
			continue
		}
		if err := uc.Repo.AttributionNoteSet(ctx, id, toLang, translated); err != nil {
			slog.WarnContext(ctx, "note_translate insert failed", "attribution_id", id, "to", toLang, "err", err)
			continue
		}
		written++
	}
	return written, nil
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
