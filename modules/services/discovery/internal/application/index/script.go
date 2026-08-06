package index

import (
	"context"
	"log/slog"
	"net/url"
	"strings"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// runScript asks the source's own script what the page said.
//
// A source without a script, or a script that fails, yields nothing and the
// model answers as it always did. Breaking a crawl because somebody's regex
// threw would be a worse outcome than a slower one.
func (s *Service) runScript(ctx context.Context, e *domain.Extraction, sourceID string, body []byte) map[string]script.Fields {
	if s.Scripts == nil || !s.Scripts.Has(sourceID) {
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
	out, err := s.Scripts.Run(ctx, sourceID, page, items)
	if err != nil {
		slog.WarnContext(ctx, "script_failed", "source", sourceID, "url", e.URL, "err", err.Error())
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
	}
	for _, ref := range f.References {
		source, tokens, ok := strings.Cut(strings.TrimSpace(ref), " ")
		if !ok {
			continue
		}
		expanded, _ := domain.ExpandRefs(source, tokens)
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
