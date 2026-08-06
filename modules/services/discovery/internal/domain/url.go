package domain

import (
	"net/url"
	"strings"
)

// URLKey is what makes two addresses the same page.
//
// The scheme is dropped. A host that redirects http to https serves one page
// under two names, and its own sitemap may well list the one it redirects away
// from. Keyed by the full address, a schedule then never matches: every entry
// looks new, is fetched, redirects onto a row we already had, and is fetched
// again on the next tick.
func URLKey(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	key := strings.ToLower(u.Host) + u.EscapedPath()
	if u.RawQuery != "" {
		key += "?" + u.RawQuery
	}
	return strings.TrimSuffix(key, "/")
}
