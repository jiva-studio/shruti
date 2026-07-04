package mcpsrv

import (
	"context"
	"encoding/base64"
	"strings"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/config"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/embed"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/library"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/refs"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/search"
)

// Deps carries the shared, long-lived dependencies into every tool handler.
// Search/Embed are nil when Postgres/embedding are not configured — the two
// tools that need them degrade to dependency_failed.
type Deps struct {
	Cfg     config.Config
	Search  *search.Repo
	Embed   *embed.Client
	Catalog *catalog.Repo
	Library *library.Repo
}

// webLocales are the web-app UI locales the public deep-link supports.
var webLocales = map[string]bool{
	"en": true, "ru": true, "uk": true, "sr-latn": true, "sr-cyrl": true,
}

const docKinds = "commentary|prose_chapter|letter"

func isDocKind(k string) bool {
	switch k {
	case "commentary", "prose_chapter", "letter":
		return true
	}
	return false
}

func isTrackKind(k string) bool { return k == "lecture" || k == "conversation" }

// localeForWeb maps a request lang to the web deep-link locale (else "en").
func localeForWeb(lang string) string {
	l := strings.ToLower(lang)
	if webLocales[l] {
		return l
	}
	return "en"
}

// trackURL builds the public shruti.app page for a track. Purely
// derived: slug = track_id minus the "track_" prefix; locale per localeForWeb.
func trackURL(trackID, lang string) string {
	slug := strings.TrimPrefix(trackID, "track_")
	return "https://shruti.app/" + localeForWeb(lang) + "/app/" + slug
}

func clamp(n, def, max int) int {
	if n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func snippet(text string) string {
	const maxRunes = 240
	t := strings.Join(strings.Fields(text), " ")
	r := []rune(t)
	if len(r) <= maxRunes {
		return t
	}
	return strings.TrimSpace(string(r[:maxRunes])) + "…"
}

func preview(text string, maxRunes int) string {
	t := strings.TrimSpace(text)
	r := []rune(t)
	if len(r) <= maxRunes {
		return t
	}
	return strings.TrimSpace(string(r[:maxRunes])) + "…"
}

// nameField returns a per-language name value: a string in lang, or the whole
// map when lang is empty (all locales).
func nameField(m map[string]string, lang string) any {
	if lang == "" {
		out := make(map[string]string, len(m))
		for k, v := range m {
			out[k] = v
		}
		return out
	}
	return catalogPick(m, lang)
}

// catalogPick mirrors catalog.pick (lang -> en -> any) for a name map.
func catalogPick(m map[string]string, lang string) string {
	if lang != "" {
		if v, ok := m[lang]; ok {
			return v
		}
	}
	if v, ok := m["en"]; ok {
		return v
	}
	for _, v := range m {
		return v
	}
	return ""
}

// sourceRefFull builds {id, code, name} for a source (maps when lang=="").
func sourceRefFull(sd *catalog.SourceDict, id, lang string) map[string]any {
	m := map[string]any{"id": id}
	if s, ok := sd.Get(id); ok {
		m["code"] = nameField(s.Codes, lang)
		m["name"] = nameField(s.Names, lang)
	}
	return m
}

// sourceRefSmall builds {id, code} for a source (code as a single string).
func sourceRefSmall(sd *catalog.SourceDict, id, lang string) map[string]any {
	m := map[string]any{"id": id}
	if s, ok := sd.Get(id); ok {
		m["code"] = s.Code(lang)
	}
	return m
}

// authorRef builds {id, name} for an author, or nil when id is empty.
func authorRef(ad *catalog.EntityDict, id, lang string) map[string]any {
	if id == "" {
		return nil
	}
	m := map[string]any{"id": id}
	if e, ok := ad.Get(id); ok {
		m["name"] = nameField(e.Names, lang)
	} else {
		m["name"] = ""
	}
	return m
}

// locationRef builds {id, name} for a location, or nil when id is empty.
func locationRef(ld *catalog.EntityDict, id, lang string) map[string]any {
	if id == "" {
		return nil
	}
	m := map[string]any{"id": id}
	if e, ok := ld.Get(id); ok {
		m["name"] = nameField(e.Names, lang)
	} else {
		m["name"] = ""
	}
	return m
}

// referenceObj builds the shared Reference shape {ref, source:{id,code}, tokens}.
func referenceObj(sd *catalog.SourceDict, sourceID, tokens, human, lang string) map[string]any {
	return map[string]any{
		"ref":    human,
		"source": sourceRefSmall(sd, sourceID, lang),
		"tokens": tokens,
	}
}

// trackMeta builds the shared TrackMeta shape.
func trackMeta(t *catalog.Track, sd *catalog.SourceDict, ad, ld *catalog.EntityDict, lang string) map[string]any {
	m := map[string]any{
		"track_id":    t.ID,
		"title":       t.Title(lang),
		"date":        t.Date,
		"kind":        t.Kind(),
		"languages":   t.Languages,
		"duration_ms": t.Duration(lang),
		"url":         trackURL(t.ID, lang),
	}
	if a := authorRef(ad, t.AuthorID, lang); a != nil {
		m["author"] = a
	} else {
		m["author"] = nil
	}
	if l := locationRef(ld, t.LocationID, lang); l != nil {
		m["location"] = l
	} else {
		m["location"] = nil
	}
	if t.Languages == nil {
		m["languages"] = []string{}
	}
	return m
}

// resolveSourceParam maps the search/list `source` param (a "BG"/"БГ" code OR a
// source_id) to a source_id. Empty in => empty out (no filter).
func resolveSourceParam(sd *catalog.SourceDict, source string) (string, bool) {
	if source == "" {
		return "", true
	}
	if _, ok := sd.Get(source); ok {
		return source, true
	}
	return sd.ResolveBook(source)
}

// resolveReference resolves a reference input (ref string OR source+tokens) to
// (sourceID, tokens). stage is "source" or "verse" for not_found details.
func resolveReference(sd *catalog.SourceDict, ref, source, tokens string) (sourceID, tok, stage string, ok bool) {
	if ref != "" {
		book, tk := refs.SplitBookTokens(ref)
		id, found := sd.ResolveBook(book)
		if !found {
			return "", "", "source", false
		}
		return id, refs.NormalizeToken(tk), "", true
	}
	if source != "" {
		id, found := resolveSourceParam(sd, source)
		if !found {
			return "", "", "source", false
		}
		return id, refs.NormalizeToken(tokens), "", true
	}
	return "", "", "source", false
}

// encodeTrackCursor / decodeTrackCursor carry (date,id) across track.list pages.
func encodeTrackCursor(date, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(date + "\x00" + id))
}

func decodeTrackCursor(cur string) (date, id string) {
	if cur == "" {
		return "", ""
	}
	b, err := base64.RawURLEncoding.DecodeString(cur)
	if err != nil {
		return "", ""
	}
	parts := strings.SplitN(string(b), "\x00", 2)
	if len(parts) != 2 {
		return "", ""
	}
	return parts[0], parts[1]
}

// loadDicts loads the three catalog dictionaries a request may need.
func (d *Deps) loadDicts(ctx context.Context) (*catalog.SourceDict, *catalog.EntityDict, *catalog.EntityDict, error) {
	sd, err := d.Catalog.LoadSources(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	ad, err := d.Catalog.LoadAuthors(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	ld, err := d.Catalog.LoadLocations(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	return sd, ad, ld, nil
}
