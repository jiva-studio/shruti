package sqlitedb

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCatalogForPicksTheNewestVersionOfItsScheme(t *testing.T) {
	var m manifest
	if err := json.Unmarshal([]byte(`{"databases": [
		{"version": 20260901000000, "scheme": 20260701},
		{"version": 20260801000000, "scheme": 20260621},
		{"version": 20260701000000, "scheme": 20260621},
		{"version": 20260501000000, "scheme": 20260520}
	]}`), &m); err != nil {
		t.Fatal(err)
	}
	got, err := catalogFor(m.Databases, 20260621)
	if err != nil {
		t.Fatal(err)
	}
	if got != "20260801000000" {
		t.Fatalf("picked %s, want the newest scheme-20260621 catalog", got)
	}
	if _, err := catalogFor(m.Databases, 20250101); err == nil {
		t.Fatal("a scheme nobody published resolved to a catalog")
	}
}

// A newer catalog built for a scheme this binary does not read is never
// downloaded, while the library still refreshes.
func TestRefreshSkipsACatalogOfAnotherScheme(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src.db")
	writeDB(t, src, "lib-new")
	body, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	var fetched []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetched = append(fetched, r.URL.Path)
		switch {
		case r.URL.Path == "/public/config.json":
			_, err := w.Write([]byte(`{"databases": [{"version": 2, "scheme": 999}, {"version": 1, "scheme": 7}],
				"library": {"versions": [{"version": 5}]}}`))
			if err != nil {
				t.Error(err)
			}
		case strings.HasSuffix(r.URL.Path, ".db"):
			if _, err := w.Write(body); err != nil {
				t.Error(err)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	dir := t.TempDir()
	cat, lib := filepath.Join(dir, "current.db"), filepath.Join(dir, "library.db")
	writeDB(t, cat, "cat-1")
	writeDB(t, lib, "lib-old")
	if err := os.WriteFile(versionSidecar(cat), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	catH, err := NewHandle(t.Context(), cat)
	if err != nil {
		t.Fatal(err)
	}
	libH, err := NewHandle(t.Context(), lib)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := catH.Close(); err != nil {
			t.Error(err)
		}
		if err := libH.Close(); err != nil {
			t.Error(err)
		}
	})

	b := NewBootstrap(srv.URL, lib, cat, 7)
	b.SetHandles(libH, catH)
	if err := b.RefreshOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, p := range fetched {
		if p == "/public/db/shruti.2.db" {
			t.Fatal("downloaded a catalog built for another scheme")
		}
	}
	db, release, err := libH.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if got := readValue(t, db); got != "lib-new" {
		t.Fatalf("library reads %q after refresh", got)
	}
}
