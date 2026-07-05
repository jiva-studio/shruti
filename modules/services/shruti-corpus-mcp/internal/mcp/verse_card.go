package mcpsrv

import (
	"context"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
)

const verseCardURI = "ui://corpus/verse-card.html"

// registerVerseRender wires verse_render — an inline card that renders the whole
// shloka (original script, transliteration in the requested language, word-by-
// word, translation). It assembles verse_get + verse_synonyms + verse_translation
// into one structuredContent payload and points at the verse-card UI resource.
func registerVerseRender(srv *server.MCPServer, d *Deps) {
	const kind = "verse_render"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription(
			"Show a verse to the user. THE DEFAULT way to display/read a scripture verse: renders an "+
				"inline card with the original script (centered), transliteration in the requested language, "+
				"the word-by-word, and the translation — all at once. Use this whenever the user asks to see, "+
				"read, open, or quote a specific verse (\"покажи БГ 2.13\", \"read Bhagavad-gita 2.13\"). "+
				"The other verse_* tools are for fetching raw data; for DISPLAY prefer this one. "+
				"Address by ref (\"BG 2.13\"), source+tokens, or id; lang sets the script + translation language."),
		mcp.WithString("ref", mcp.Description("Reference string, e.g. \"BG 2.13\".")),
		mcp.WithString("source", mcp.Description("Book code / source_id (with tokens).")),
		mcp.WithString("tokens", mcp.Description("Position within the book (with source).")),
		mcp.WithString("id", mcp.Description("verse_id.")),
		mcp.WithString("lang", mcp.Required(), mcp.Description("Display language, e.g. \"en\", \"ru\".")),
		mcp.WithString("kind", mcp.Description("Translation kind; default \"canonical\".")),
	)
	t.Meta = uiMeta(verseCardURI)
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

		tr, err := d.Library.GetTranslation(ctx, v.ID, lang, tkind)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if tr == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such translation", map[string]any{"lang": lang, "kind": tkind, "stage": "translation"}), nil
		}
		words, err := d.Library.Words(ctx, v.ID, lang, tkind)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		translit := d.Library.Transliteration(ctx, v.ID, lang, v.Transliteration)

		syn := make([]map[string]any, 0, len(words))
		for _, w := range words {
			syn = append(syn, map[string]any{"word": w.Surface, "meaning": w.Gloss})
		}
		data := map[string]any{
			"id":              v.ID,
			"ref":             sd.RefString(v.SourceID, v.Tokens, lang),
			"source":          sourceRefFull(sd, v.SourceID, lang),
			"tokens":          v.Tokens,
			"lang":            lang,
			"kind":            tr.Kind,
			"original":        splitLines(v.Text),
			"transliteration": splitLines(translit),
			"synonyms":        syn,
			"translation":     tr.Text,
		}

		// Human text for the model (the widget renders the card; this is the text
		// content the LLM reasons over).
		var b strings.Builder
		b.WriteString(sd.RefString(v.SourceID, v.Tokens, lang))
		if v.Text != "" {
			b.WriteString("\n" + v.Text)
		}
		if translit != "" {
			b.WriteString("\n" + translit)
		}
		b.WriteString("\n" + tr.Text)

		logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
		res := mcp.NewToolResultText(b.String())
		res.StructuredContent = data
		return res, nil
	})
}

// registerVerseCardResource serves the verse-card UI bundle. No external hosts —
// the card is pure text/markup, so the CSP allows nothing.
func registerVerseCardResource(srv *server.MCPServer, d *Deps) {
	connectDomains := []string{}
	resourceDomains := []string{}
	csp := map[string]any{
		"connectDomains":  connectDomains,
		"resourceDomains": resourceDomains,
	}
	res := mcp.NewResource(verseCardURI, "Corpus verse card",
		mcp.WithResourceDescription("Inline card for a scripture verse: original, transliteration, word-by-word, translation."),
		mcp.WithMIMEType("text/html;profile=mcp-app"),
	)
	res.Meta = resourceUIMeta(connectDomains, resourceDomains)
	srv.AddResource(res, func(ctx context.Context, req mcp.ReadResourceRequest) ([]mcp.ResourceContents, error) {
		return uiContents(verseCardURI, verseCardHTML, map[string]any{"csp": csp}), nil
	})
}
