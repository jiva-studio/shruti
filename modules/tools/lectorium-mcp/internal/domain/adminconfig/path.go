// Package adminconfig models the closed allowlist of runtime-mutable
// configuration paths the operator can flip via admin_config_set. Each
// entry pairs a path pattern with a domain validator. The application
// layer matches the requested path against this list and dispatches to
// the relevant port; the MCP delivery layer is a thin marshal/unmarshal
// dispatcher.
//
// New writable path = one new entry here + one new port-method
// implementation. The MCP tool description is generated from this list
// so the docs can't drift from code.
package adminconfig

import (
	"fmt"
	"net/url"
	"strings"
)

// WritablePath describes one rule in the allowlist.
//
// Pattern is a literal dotted path or a path with one '*' segment
// substituted for an extracted parameter. Examples:
//   "transcribe.default"                       — literal
//   "transcribe.providers.*.endpoint"          — '*' captured as the
//                                                provider name; available
//                                                via Match().params["name"].
//
// Validate runs the domain-level checks (non-empty, valid URL, …) before
// dispatch. Returns an error with a user-friendly message.
type WritablePath struct {
	Pattern  string
	Validate func(value string) error

	// Wildcard is the parameter name extracted from the '*' segment, if
	// any. Empty for literal patterns.
	Wildcard string
}

// Match reports whether a path matches the pattern. For wildcard
// patterns, params holds the captured value keyed by Wildcard.
func (w WritablePath) Match(path string) (params map[string]string, ok bool) {
	if w.Wildcard == "" {
		if path == w.Pattern {
			return nil, true
		}
		return nil, false
	}
	starIdx := strings.Index(w.Pattern, "*")
	if starIdx < 0 {
		return nil, false
	}
	prefix := w.Pattern[:starIdx]
	suffix := w.Pattern[starIdx+1:]
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return nil, false
	}
	middle := path[len(prefix) : len(path)-len(suffix)]
	if middle == "" || strings.Contains(middle, ".") {
		return nil, false
	}
	return map[string]string{w.Wildcard: middle}, true
}

// WritablePaths is the canonical declarative whitelist. Order matters
// only for documentation listing — Match is unambiguous (literal patterns
// can't collide with '*' patterns whose middle segment is dotless).
//
// Adding a path here without wiring its application-layer dispatch will
// surface a "dispatch missing" internal error to callers — that's the
// signal to add the matching port-method implementation.
func WritablePaths() []WritablePath {
	return []WritablePath{
		{Pattern: "transcribe.default", Validate: NonEmpty},
		{Pattern: "transcribe.providers.*.endpoint", Validate: ValidURL, Wildcard: "name"},
	}
}

// PatternsForDescription returns the patterns as written, suitable for
// MCP tool description text.
func PatternsForDescription() []string {
	out := make([]string, 0, len(WritablePaths()))
	for _, w := range WritablePaths() {
		out = append(out, w.Pattern)
	}
	return out
}

// NonEmpty rejects whitespace-only strings.
func NonEmpty(value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("value cannot be empty")
	}
	return nil
}

// ValidURL accepts http(s) URLs with a non-empty host. Used for endpoint
// swaps so a typo doesn't silently route requests at /dev/null.
func ValidURL(value string) error {
	v := strings.TrimSpace(value)
	if v == "" {
		return fmt.Errorf("URL cannot be empty")
	}
	u, err := url.Parse(v)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("URL scheme must be http or https")
	}
	if u.Host == "" {
		return fmt.Errorf("URL must include a host")
	}
	return nil
}
