package storage

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBunnyRefusesAKeyThatLeavesItsPath(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	src := filepath.Join(t.TempDir(), "x.mp3")
	if err := os.WriteFile(src, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := NewBunny("zone", "secret", srv.URL, "https://cdn.example.test")
	for _, key := range []string{"public/../private/x", "../../x", "public/./x", "public//x", "/public/x", "", "public/x/.."} {
		if _, err := b.Exists(t.Context(), key); err == nil {
			t.Errorf("Exists(%q) succeeded", key)
		}
		if err := b.Upload(t.Context(), key, src, "audio/mpeg", ""); err == nil {
			t.Errorf("Upload(%q) succeeded", key)
		}
	}
	if requests != 0 {
		t.Fatalf("%d requests reached the store", requests)
	}
}

func TestBunnyKeepsReservedCharactersInsideTheirSegment(t *testing.T) {
	var gotRawPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRawPath, gotQuery = r.URL.EscapedPath(), r.URL.RawQuery
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	b := NewBunny("zone", "secret", srv.URL, "https://cdn.example.test")
	if _, err := b.Exists(t.Context(), "public/a#b?c%2e/x y.mp3"); err != nil {
		t.Fatal(err)
	}
	if gotRawPath != "/zone/public/a%23b%3Fc%252e/x%20y.mp3" || gotQuery != "" {
		t.Fatalf("path=%q query=%q", gotRawPath, gotQuery)
	}
}
