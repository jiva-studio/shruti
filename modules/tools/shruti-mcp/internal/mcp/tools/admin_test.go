package tools

import (
	"testing"

	admindomain "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/adminconfig"
)

// TestWritablePathsMatchers pins the canonical allowlist + the wildcard
// extraction. The list is the v2 declarative-config public surface;
// adding/removing entries is a deliberate change that should also touch
// this test.
func TestWritablePathsMatchers(t *testing.T) {
	wantMatches := map[string]string{
		"transcribe.default":                                "transcribe.default",
		"transcribe.providers.foo.endpoint":                 "transcribe.providers.*.endpoint",
		"transcribe.providers.transcriber-service.endpoint": "transcribe.providers.*.endpoint",
	}
	rejects := []string{
		"",
		"ffmpeg.bin",
		"transcribe.providers..endpoint",        // empty name
		"transcribe.providers.foo",              // missing .endpoint
		"transcribe.providers.foo.bar.endpoint", // dotted middle not allowed
	}
	paths := admindomain.WritablePaths()
	for path, wantPattern := range wantMatches {
		matched := false
		for _, wp := range paths {
			if _, ok := wp.Match(path); ok {
				if wp.Pattern != wantPattern {
					t.Errorf("path %q matched %q; want %q", path, wp.Pattern, wantPattern)
				}
				matched = true
				break
			}
		}
		if !matched {
			t.Errorf("WritablePaths did not match %q", path)
		}
	}
	for _, p := range rejects {
		for _, wp := range paths {
			if _, ok := wp.Match(p); ok {
				t.Errorf("WritablePaths unexpectedly matched %q via pattern %q", p, wp.Pattern)
				break
			}
		}
	}
}

func TestWildcardCaptured(t *testing.T) {
	for _, wp := range admindomain.WritablePaths() {
		if wp.Pattern != "transcribe.providers.*.endpoint" {
			continue
		}
		params, ok := wp.Match("transcribe.providers.transcriber-service.endpoint")
		if !ok {
			t.Fatal("expected wildcard match")
		}
		if params["name"] != "transcriber-service" {
			t.Errorf("wildcard not captured: %+v", params)
		}
		return
	}
	t.Fatal("transcribe.providers.*.endpoint not present in WritablePaths")
}

func TestValidURL(t *testing.T) {
	good := []string{
		"http://127.0.0.1:8080",
		"https://example.com/x?a=1",
	}
	bad := []string{
		"",
		"   ",
		"ftp://example.com",
		"not a url",
		"http://", // no host
	}
	for _, u := range good {
		if err := admindomain.ValidURL(u); err != nil {
			t.Errorf("ValidURL(%q) → unexpected error %v", u, err)
		}
	}
	for _, u := range bad {
		if err := admindomain.ValidURL(u); err == nil {
			t.Errorf("ValidURL(%q) → expected error, got nil", u)
		}
	}
}

func TestNonEmpty(t *testing.T) {
	if err := admindomain.NonEmpty(""); err == nil {
		t.Error("expected error for empty value")
	}
	if err := admindomain.NonEmpty("   "); err == nil {
		t.Error("expected error for whitespace-only value")
	}
	if err := admindomain.NonEmpty("x"); err != nil {
		t.Errorf("unexpected error %v", err)
	}
}

func TestWalk(t *testing.T) {
	tree := map[string]any{
		"a": map[string]any{
			"b": map[string]any{
				"c": "leaf",
			},
		},
	}
	if v, ok := walk(tree, "a.b.c"); !ok || v != "leaf" {
		t.Errorf("walk(a.b.c) = (%v, %v), want ('leaf', true)", v, ok)
	}
	if _, ok := walk(tree, "a.b.x"); ok {
		t.Error("walk(a.b.x) should not be found")
	}
	if _, ok := walk(tree, "x"); ok {
		t.Error("walk(x) should not be found")
	}
}
