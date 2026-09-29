package storage

import (
	"fmt"
	"net/url"
	"strings"
)

// objectURL is {endpoint}/{zone}/{key} with every key segment escaped on its
// own, so `#`, `?` and `%` stay inside the key. A key with an empty, `.` or
// `..` segment is refused, and the result is checked to still lie under the
// zone.
func objectURL(endpoint, zone, key string) (string, error) {
	segments := strings.Split(key, "/")
	for i, s := range segments {
		if s == "" || s == "." || s == ".." {
			return "", fmt.Errorf("storage key %q has an empty or relative segment", key)
		}
		segments[i] = url.PathEscape(s)
	}
	zonePath := "/" + url.PathEscape(zone) + "/"
	raw := endpoint + zonePath + strings.Join(segments, "/")
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("storage key %q: %w", key, err)
	}
	if !strings.HasPrefix(u.EscapedPath(), zonePath) || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("storage key %q leaves the zone", key)
	}
	return raw, nil
}
