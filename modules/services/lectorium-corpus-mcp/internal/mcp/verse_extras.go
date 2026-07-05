package mcpsrv

import (
	"context"
	"time"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/envelope"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/library"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// resolveVerse turns (id | ref | source+tokens) into a verse, or returns a
// ready-to-send error envelope. Shared by verse_translation and verse_synonyms
// (same addressing as verse_get).
func (d *Deps) resolveVerse(ctx context.Context, kind string, sd *catalog.SourceDict, id, ref, source, tokens string) (*library.Verse, *mcp.CallToolResult) {
	if id != "" {
		v, err := d.Library.GetByID(ctx, id)
		if err != nil {
			return nil, envelope.Err(kind, envelope.CodeInternal, err.Error(), nil)
		}
		if v == nil {
			return nil, envelope.Err(kind, envelope.CodeNotFound, "no such verse", map[string]any{"id": id, "stage": "verse"})
		}
		return v, nil
	}
	if ref == "" && source == "" {
		return nil, envelope.Err(kind, envelope.CodeInvalidArgument, "provide ref, source+tokens, or id", nil)
	}
	sourceID, tok, stage, ok := resolveReference(sd, ref, source, tokens)
	if !ok {
		return nil, envelope.Err(kind, envelope.CodeNotFound, "unresolvable reference", map[string]any{"ref": humanRef(ref, source, tokens), "stage": stage})
	}
	v, err := d.Library.GetByRef(ctx, sourceID, tok)
	if err != nil {
		return nil, envelope.Err(kind, envelope.CodeInternal, err.Error(), nil)
	}
	if v == nil {
		return nil, envelope.Err(kind, envelope.CodeNotFound, "no such verse", map[string]any{"ref": humanRef(ref, source, tokens), "stage": "verse"})
	}
	return v, nil
}

// ── verse_translation ────────────────────────────────────────────────────────

func registerVerseTranslation(srv *server.MCPServer, d *Deps) {
	const kind = "verse_translation"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Fetch the text of ONE translation of a verse (data, not a card — to display a verse use "+
			"verse_render). Defaults to the canonical (kind=canonical); pass a `kind` from verse_get's `alternatives` "+
			"manifest to fetch a specific rendering."),
		mcp.WithString("ref", mcp.Description("Reference string, e.g. \"BG 2.13\".")),
		mcp.WithString("source", mcp.Description("Book code / source_id (with tokens).")),
		mcp.WithString("tokens", mcp.Description("Position within the book (with source).")),
		mcp.WithString("id", mcp.Description("verse_id.")),
		mcp.WithString("lang", mcp.Required(), mcp.Description("Translation language, e.g. \"en\", \"ru\".")),
		mcp.WithString("kind", mcp.Description("Translation kind; default \"canonical\".")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang, err := req.RequireString("lang")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "lang is required", nil), nil
		}
		tkind := req.GetString("kind", "canonical")
		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		ad, err := d.Catalog.LoadAuthors(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		ref := req.GetString("ref", "")
		v, errRes := d.resolveVerse(ctx, kind, sd, req.GetString("id", ""), ref, req.GetString("source", ""), req.GetString("tokens", ""))
		if errRes != nil {
			return errRes, nil
		}
		tr, err := d.Library.GetTranslation(ctx, v.ID, lang, tkind)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if tr == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such translation", map[string]any{"lang": lang, "kind": tkind, "stage": "translation"}), nil
		}
		obj := map[string]any{
			"ref":         sd.RefString(v.SourceID, v.Tokens, lang),
			"id":          v.ID,
			"lang":        lang,
			"kind":        tr.Kind,
			"translation": tr.Text,
		}
		if a := authorRef(ad, tr.AuthorID, lang); a != nil {
			obj["author"] = a
		}
		if tr.Note != "" {
			obj["note"] = tr.Note
		}
		logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
		return envelope.Result(kind, obj), nil
	})
}

// ── verse_synonyms ───────────────────────────────────────────────────────────

func registerVerseSynonyms(srv *server.MCPServer, d *Deps) {
	const kind = "verse_synonyms"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Fetch the word-by-word (\"Synonyms\") as a raw {word, meaning} array for one verse "+
			"translation (data — verse_render already shows the word-by-word inside the card). Defaults to the "+
			"canonical rendering; pass `kind` for an alternative."),
		mcp.WithString("ref", mcp.Description("Reference string, e.g. \"BG 2.13\".")),
		mcp.WithString("source", mcp.Description("Book code / source_id (with tokens).")),
		mcp.WithString("tokens", mcp.Description("Position within the book (with source).")),
		mcp.WithString("id", mcp.Description("verse_id.")),
		mcp.WithString("lang", mcp.Required(), mcp.Description("Language of the glosses, e.g. \"en\", \"ru\".")),
		mcp.WithString("kind", mcp.Description("Translation kind; default \"canonical\".")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang, err := req.RequireString("lang")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "lang is required", nil), nil
		}
		tkind := req.GetString("kind", "canonical")
		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		ref := req.GetString("ref", "")
		v, errRes := d.resolveVerse(ctx, kind, sd, req.GetString("id", ""), ref, req.GetString("source", ""), req.GetString("tokens", ""))
		if errRes != nil {
			return errRes, nil
		}
		words, err := d.Library.Words(ctx, v.ID, lang, tkind)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		logQuery(ctx, kind, ref, nil, nil, len(words), lang, start)
		return envelope.Result(kind, synonymsObject(sd, v, lang, tkind, words)), nil
	})
}
