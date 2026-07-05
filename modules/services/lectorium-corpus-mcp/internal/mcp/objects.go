package mcpsrv

import (
	"strings"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/library"
)

// splitLines splits a stored multi-line verse field (original / transliteration)
// into an array of lines. Empty input yields an empty array (not [""]).
func splitLines(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, "\n")
}

// verseObject builds the language-independent verse skeleton (script +
// transliteration as line arrays). Translation text and the alternatives
// manifest are added by the verse_get handler, which needs the repo + catalog.
func verseObject(sd *catalog.SourceDict, v *library.Verse, lang string) map[string]any {
	return map[string]any{
		"id":              v.ID,
		"ref":             sd.RefString(v.SourceID, v.Tokens, lang),
		"source":          sourceRefFull(sd, v.SourceID, lang),
		"tokens":          v.Tokens,
		"original":        splitLines(v.Text),
		"transliteration": splitLines(v.Transliteration),
	}
}

// synonymsObject builds the verse_synonyms payload: an ordered {word, meaning} array.
func synonymsObject(sd *catalog.SourceDict, v *library.Verse, lang, kind string, words []library.Word) map[string]any {
	syn := make([]map[string]any, 0, len(words))
	for _, w := range words {
		syn = append(syn, map[string]any{"word": w.Surface, "meaning": w.Gloss})
	}
	return map[string]any{
		"ref":      sd.RefString(v.SourceID, v.Tokens, lang),
		"id":       v.ID,
		"lang":     lang,
		"kind":     kind,
		"synonyms": syn,
	}
}

// documentObject builds the document_get payload (bodies slimmed to lang if set).
func documentObject(sd *catalog.SourceDict, ad *catalog.EntityDict, doc *library.Document, lang string) map[string]any {
	bodies := map[string]library.DocBody{}
	if lang != "" {
		if b, ok := doc.Bodies[lang]; ok {
			bodies[lang] = b
		}
	} else {
		for k, b := range doc.Bodies {
			bodies[k] = b
		}
	}
	obj := map[string]any{
		"id":     doc.ID,
		"kind":   doc.Kind,
		"source": sourceRefSmall(sd, doc.SourceID, lang),
		"tokens": doc.Tokens,
		"date":   doc.Date,
		"bodies": bodies,
	}
	if a := authorRef(ad, doc.AuthorID, lang); a != nil {
		obj["author"] = a
	}
	return obj
}

func buildDocFilter(sourceID, tokens, kind, authorID, cursor string, limit int) library.DocFilter {
	return library.DocFilter{
		SourceID: sourceID,
		Tokens:   tokens,
		Kind:     kind,
		AuthorID: authorID,
		CursorID: cursor,
		Limit:    limit,
	}
}

// humanRef renders the reference the caller supplied, for error details.
func humanRef(ref, source, tokens string) string {
	if ref != "" {
		return ref
	}
	if tokens != "" {
		return strings.TrimSpace(source + " " + tokens)
	}
	return source
}

// putIf adds k=v to m only when v is a non-empty string.
func putIf(m map[string]any, k, v string) {
	if v != "" {
		m[k] = v
	}
}

// strOr dereferences a *string or returns "".
func strOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// round2f rounds a float to 2 decimals for stable JSON scores.
func round2f(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}
