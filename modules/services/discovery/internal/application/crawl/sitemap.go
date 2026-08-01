package crawl

import (
	"context"
	"encoding/xml"
	"net/url"
	"strings"

	"github.com/jiva-studio/lectorium/discovery/internal/infra/fetch"
)

// maxSitemaps bounds how many sitemap documents one source is worth reading.
// An index pointing at hundreds is a crawl of its own, and the link frontier
// covers the rest.
const maxSitemaps = 25

// sitemapDoc covers both shapes the sitemap protocol defines: an index of
// sitemaps and a set of URLs.
type sitemapDoc struct {
	Sitemaps []struct {
		Loc string `xml:"loc"`
	} `xml:"sitemap"`
	URLs []struct {
		Loc     string `xml:"loc"`
		LastMod string `xml:"lastmod"`
	} `xml:"url"`
}

// SitemapURLs asks a host for its own list of pages.
//
// This is a published protocol, not knowledge of any site: whatever answers is
// used, and a host that publishes nothing simply falls back to following
// links. When it does answer it is the cheapest enumeration there is — a
// complete URL list for a couple of requests instead of a walk over every page.
func (s *Service) SitemapURLs(ctx context.Context, seed string, req fetch.Request) []string {
	base, err := url.Parse(seed)
	if err != nil {
		return nil
	}
	origin := base.Scheme + "://" + base.Host

	queue := s.declaredSitemaps(ctx, origin, req)
	if len(queue) == 0 {
		queue = []string{origin + "/sitemap.xml"}
	}

	seen := map[string]bool{}
	var out []string
	for len(queue) > 0 && len(seen) < maxSitemaps {
		next := queue[0]
		queue = queue[1:]
		if seen[next] {
			continue
		}
		seen[next] = true

		doc := s.readSitemap(ctx, next, req)
		if doc == nil {
			continue
		}
		for _, sm := range doc.Sitemaps {
			if loc := strings.TrimSpace(sm.Loc); loc != "" {
				queue = append(queue, loc)
			}
		}
		for _, u := range doc.URLs {
			if loc := strings.TrimSpace(u.Loc); loc != "" {
				out = append(out, loc)
			}
		}
	}
	return out
}

// declaredSitemaps reads the Sitemap: lines out of robots.txt, which is where
// a host states them.
func (s *Service) declaredSitemaps(ctx context.Context, origin string, req fetch.Request) []string {
	resp, err := s.Fetcher.Get(ctx, origin+"/robots.txt", req)
	if err != nil || len(resp.Body) == 0 {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(resp.Body), "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found || !strings.EqualFold(strings.TrimSpace(key), "sitemap") {
			continue
		}
		if v := strings.TrimSpace(value); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func (s *Service) readSitemap(ctx context.Context, rawURL string, req fetch.Request) *sitemapDoc {
	resp, err := s.Fetcher.Get(ctx, rawURL, req)
	if err != nil || len(resp.Body) == 0 {
		return nil
	}
	var doc sitemapDoc
	if err := xml.Unmarshal(resp.Body, &doc); err != nil {
		return nil
	}
	return &doc
}
