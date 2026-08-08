package index

import (
	"context"
	"log/slog"
	"net/url"
	"strings"

	"github.com/jiva-studio/lectorium/discovery/internal/application/normalize"
	"github.com/jiva-studio/lectorium/discovery/internal/application/script"
	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// runScript asks the source's own script what the page said.
//
// A source without a script, or a script that fails, yields nothing and the
// model answers as it always did. Breaking a crawl because somebody's regex
// threw would be a worse outcome than a slower one.
func (s *Service) runScript(ctx context.Context, e *domain.Extraction, scriptID string, body []byte) map[string]script.Fields {
	if s.Scripts == nil || !s.Scripts.Has(scriptID) {
		return nil
	}
	page := script.Page{
		URL:   e.URL,
		Title: e.PageTitle,
		Text:  e.PageText,
		HTML:  string(body),
		Path:  pathSegments(e.URL),
	}
	items := make([]script.Item, len(e.Items))
	for i, it := range e.Items {
		items[i] = script.Item{
			URL:      it.MediaURL,
			Filename: it.Filename,
			Path:     it.PathSegments,
			Context:  it.ContextText,
		}
	}
	out, err := s.Scripts.Run(ctx, scriptID, page, items)
	if err != nil {
		slog.WarnContext(ctx, "script_failed", "script", scriptID, "url", e.URL, "err", err.Error())
		return nil
	}
	return out
}

// scriptResult is what a script said, in the shape the rest of the write path
// already understands.
func scriptResult(f script.Fields) normalize.Result {
	r := normalize.Result{
		Title:           strings.TrimSpace(f.Title),
		Author:          domain.Name(f.Author),
		Authors:         names(f),
		Location:        domain.Place(f.Location),
		Date:            f.Date,
		Language:        f.Language,
		CollectionTitle: strings.TrimSpace(f.CollectionTitle),
		DurationS:       f.DurationS,
		CoverURL:        strings.TrimSpace(f.CoverURL),
	}
	for _, ref := range f.References {
		// A script can only cite what the corpus can address. The model's
		// answers are checked this way already; the script's were not, so a
		// script naming a book we have no code for stored the name as if it
		// were one.
		if !domain.Addressable(ref.Source) {
			continue
		}
		expanded, _ := domain.ExpandRefs(ref.Source, ref.Tokens)
		r.References = append(r.References, expanded...)
	}
	return r
}

// names is everyone the script named, each written the way we write names.
func names(f script.Fields) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range append([]string{f.Author}, f.Authors...) {
		n := domain.Name(raw)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// pathSegments is the page's own path, decoded, for a script that reads a
// speaker out of a directory name.
func pathSegments(rawURL string) []string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil
	}
	from := u.Path
	if u.RawQuery != "" {
		if q, err := url.QueryUnescape(u.RawQuery); err == nil {
			if _, after, ok := strings.Cut(q, "="); ok {
				from = after
			}
		}
	}
	decoded, err := url.PathUnescape(from)
	if err != nil {
		decoded = from
	}
	var out []string
	for _, seg := range strings.Split(strings.Trim(decoded, "/"), "/") {
		if seg != "" {
			out = append(out, seg)
		}
	}
	return out
}
