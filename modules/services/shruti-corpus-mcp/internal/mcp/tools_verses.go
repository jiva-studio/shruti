package mcpsrv

import (
	"context"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/library"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
)

// ── verse_get / verse_list ──────────────────────────────────────────────────

func registerVerseGet(srv *server.MCPServer, d *Deps) {
	const kind = "verse_get"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Fetch a verse's raw fields for your own reasoning (NOT for display — to show a verse "+
			"to the user, use verse_render). Returns original script + transliteration as line arrays; with lang, also "+
			"the canonical translation inline plus an `alternatives` manifest of other translation kinds in that "+
			"language (fetch their text with verse_translation, word-by-word with verse_synonyms). "+
			"Address by ref (\"BG 2.13\"), source+tokens, or verse id."),
		mcp.WithString("ref", mcp.Description("Reference string, e.g. \"BG 2.13\".")),
		mcp.WithString("source", mcp.Description("Book code / source_id (with tokens).")),
		mcp.WithString("tokens", mcp.Description("Position within the book (with source).")),
		mcp.WithString("id", mcp.Description("verse_id.")),
		mcp.WithString("lang", mcp.Description("Answer language. Set it to get the canonical translation + alternatives manifest.")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang := req.GetString("lang", "")
		id := req.GetString("id", "")
		ref := req.GetString("ref", "")
		source := req.GetString("source", "")
		tokens := req.GetString("tokens", "")

		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		ad, err := d.Catalog.LoadAuthors(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}

		if id != "" {
			v, err := d.Library.GetByID(ctx, id)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			if v == nil {
				return envelope.Err(kind, envelope.CodeNotFound, "no such verse", map[string]any{"id": id, "stage": "verse"}), nil
			}
			obj, err := d.verseObjectWithCovers(ctx, sd, ad, v, lang)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
			return envelope.Result(kind, obj), nil
		}

		if ref == "" && source == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "provide ref, source+tokens, or id", nil), nil
		}
		sourceID, tok, stage, ok := resolveReference(sd, ref, source, tokens)
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, "unresolvable reference", map[string]any{"ref": humanRef(ref, source, tokens), "stage": stage}), nil
		}
		v, err := d.Library.GetByRef(ctx, sourceID, tok)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if v == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such verse", map[string]any{"ref": humanRef(ref, source, tokens), "stage": "verse"}), nil
		}
		obj, err := d.verseObjectWithCovers(ctx, sd, ad, v, lang)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
		return envelope.Result(kind, obj), nil
	})
}

// verseObjectWithCovers builds the verse_get payload: the language-independent
// skeleton, a `covers` span for merged verses, and — when lang is set — the
// canonical translation inline plus an `alternatives` manifest (other kinds in
// that language, metadata only; fetch their text via verse_translation).
func (d *Deps) verseObjectWithCovers(ctx context.Context, sd *catalog.SourceDict, ad *catalog.EntityDict, v *library.Verse, lang string) (map[string]any, error) {
	obj := verseObject(sd, v, lang)
	covers, err := d.Library.VerseCovers(ctx, v)
	if err != nil {
		return nil, err
	}
	if covers != "" {
		obj["covers"] = covers
	}
	if lang == "" {
		return obj, nil
	}
	// Transliteration in the requested language's script (Cyrillic for ru/uk/…),
	// materialised at import; falls back to the stored Latin IAST.
	translit, err := d.Library.Transliteration(ctx, v.ID, lang, v.Transliteration)
	if err != nil {
		return nil, err
	}
	obj["transliteration"] = splitLines(translit)
	translations, err := d.Library.Translations(ctx, v.ID, lang)
	if err != nil {
		return nil, err
	}
	alternatives := []map[string]any{}
	for _, m := range translations {
		if m.Kind == "canonical" {
			obj["kind"] = "canonical"
			obj["translation"] = m.Text
			if a := authorRef(ad, m.AuthorID, lang); a != nil {
				obj["author"] = a
			}
			continue
		}
		alt := map[string]any{"kind": m.Kind}
		if a := authorRef(ad, m.AuthorID, lang); a != nil {
			alt["author"] = a
		}
		if m.Note != "" {
			alt["note"] = m.Note
		}
		alternatives = append(alternatives, alt)
	}
	obj["alternatives"] = alternatives
	return obj, nil
}

func registerVerseList(srv *server.MCPServer, d *Deps) {
	const kind = "verse_list"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("List the verses of a book / chapter. Skips .0 chapter summaries; "+
			"collapses merged verses into one item with a covers span."),
		mcp.WithString("source", mcp.Required(), mcp.Description("Book code / source_id.")),
		mcp.WithString("tokens", mcp.Description("Chapter/canto prefix, e.g. \"2\" or \"5.5\".")),
		mcp.WithString("lang", mcp.Description("Preview language.")),
		mcp.WithString("cursor", mcp.Description("Pagination cursor (last tokens).")),
		mcp.WithNumber("limit", mcp.Description("Max items (default 100, max 500).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		source := strings.TrimSpace(req.GetString("source", ""))
		if source == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "source is required", nil), nil
		}
		lang := req.GetString("lang", "")
		cursor := req.GetString("cursor", "")
		limit := clamp(req.GetInt("limit", 100), 100, 500)
		prefix := ""
		if tk := req.GetString("tokens", ""); tk != "" {
			prefix = refs.NormalizeToken(tk)
		}
		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		sourceID, ok := resolveSourceParam(sd, source)
		if !ok {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "unknown source: "+source, map[string]any{"source": source}), nil
		}
		all, err := d.Library.ListVerses(ctx, sourceID, prefix)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		items := []map[string]any{}
		var next any
		for _, it := range all {
			if cursor != "" && refs.CompareTokens(it.Tokens, cursor) <= 0 {
				continue
			}
			if len(items) >= limit {
				next = items[len(items)-1]["tokens"]
				break
			}
			human := it.Tokens
			if it.Covers != "" {
				sp := strings.SplitN(it.Covers, "-", 2)
				if len(sp) == 2 {
					human = refs.CompressRange(sp[0], sp[1])
				}
			}
			obj := map[string]any{
				"id":                  it.ID,
				"ref":                 sd.RefString(sourceID, human, lang),
				"source":              sourceRefSmall(sd, sourceID, lang),
				"tokens":              it.Tokens,
				"translation_preview": preview(catalogPick(it.Translations, lang), 200),
			}
			if it.Covers != "" {
				obj["covers"] = it.Covers
			}
			items = append(items, obj)
		}
		logQuery(ctx, kind, "", map[string]any{"source": source, "tokens": prefix}, nil, len(items), lang, start)
		return envelope.Result(kind, map[string]any{"items": items, "next_cursor": next}), nil
	})
}
