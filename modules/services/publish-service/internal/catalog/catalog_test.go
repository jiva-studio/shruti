package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// stubFetcher serves a fixed snapshot as the catalog.
type stubFetcher struct {
	body    []byte
	version string
	calls   int
}

func (f *stubFetcher) Fetch(_ context.Context, have string) (Snapshot, error) {
	f.calls++
	if have != "" && have == f.version {
		return Snapshot{Version: f.version, Unchanged: true}, nil
	}
	return Snapshot{Version: f.version, Body: f.body}, nil
}

// catalogBytes builds a minimal catalog SQLite file holding the given ids.
func catalogBytes(t *testing.T, ids ...string) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "catalog.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT)`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	for _, id := range ids {
		if _, err := db.Exec(`INSERT INTO tracks (id, title) VALUES (?, ?)`, id, "x"); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	db.Close()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	return blob
}

// PublishedTrackIDs reads the `tracks.id` column out of a catalog-shaped
// SQLite file.
func TestPublishedTrackIDs(t *testing.T) {
	r := NewReader(&stubFetcher{body: catalogBytes(t, "trk-a", "trk-b", "trk-c"), version: "20260809133448"})
	ids, err := r.PublishedTrackIDs(context.Background())
	if err != nil {
		t.Fatalf("PublishedTrackIDs: %v", err)
	}
	got := map[string]bool{}
	for _, id := range ids {
		got[id] = true
	}
	for _, want := range []string{"trk-a", "trk-b", "trk-c"} {
		if !got[want] {
			t.Errorf("missing track id %q (got %v)", want, ids)
		}
	}
	if len(ids) != 3 {
		t.Errorf("id count = %d, want 3", len(ids))
	}
}

// A catalog whose version has not moved is neither re-downloaded nor re-parsed.
func TestPublishedTrackIDsReusesUnchangedVersion(t *testing.T) {
	f := &stubFetcher{body: catalogBytes(t, "trk-a"), version: "20260809133448"}
	r := NewReader(f)
	first, err := r.PublishedTrackIDs(context.Background())
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := r.PublishedTrackIDs(context.Background())
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if len(second) != len(first) || second[0] != first[0] {
		t.Errorf("cached ids differ: %v vs %v", second, first)
	}
	if f.calls != 2 {
		t.Errorf("fetch calls = %d, want 2", f.calls)
	}
}

// manifestServer serves config.json + the version-stamped catalog objects and
// counts every request path it is asked for.
type manifestServer struct {
	manifest string
	etag     string
	objects  map[string][]byte
	hits     map[string]int
}

func (s *manifestServer) handler(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/")
	s.hits[key]++
	if key == manifestKey {
		if s.etag != "" {
			if r.Header.Get("If-None-Match") == s.etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", s.etag)
		}
		fmt.Fprint(w, s.manifest)
		return
	}
	body, ok := s.objects[key]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	_, _ = w.Write(body)
}

// The live catalog key is the greatest databases[].version in config.json —
// never a fixed filename.
func TestHTTPFetcherResolvesLatestVersion(t *testing.T) {
	blob := catalogBytes(t, "trk-a")
	srv := &manifestServer{
		manifest: `{"databases":[{"version":20260804125921},{"version":20260809133448},{"version":20260808132654}]}`,
		objects:  map[string][]byte{"public/db/shruti.20260809133448.db": blob},
		hits:     map[string]int{},
	}
	ts := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer ts.Close()

	snap, err := NewHTTPFetcher(ts.URL+"/").Fetch(context.Background(), "")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if snap.Version != "20260809133448" {
		t.Errorf("version = %q, want 20260809133448", snap.Version)
	}
	if len(snap.Body) != len(blob) {
		t.Errorf("body = %d bytes, want %d", len(snap.Body), len(blob))
	}
	if snap.Unchanged {
		t.Error("first fetch reported Unchanged")
	}
	if n := srv.hits["public/db/shruti.20260809133448.db"]; n != 1 {
		t.Errorf("catalog requests = %d, want 1", n)
	}
}

// Holding the live version skips the catalog download entirely, and the
// manifest re-read is conditional on its ETag.
func TestHTTPFetcherSkipsDownloadWhenVersionUnchanged(t *testing.T) {
	srv := &manifestServer{
		manifest: `{"databases":[{"version":20260809133448}]}`,
		etag:     `"cfg-v1"`,
		objects:  map[string][]byte{"public/db/shruti.20260809133448.db": catalogBytes(t, "trk-a")},
		hits:     map[string]int{},
	}
	ts := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer ts.Close()

	f := NewHTTPFetcher(ts.URL)
	if _, err := f.Fetch(context.Background(), ""); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	snap, err := f.Fetch(context.Background(), "20260809133448")
	if err != nil {
		t.Fatalf("second fetch: %v", err)
	}
	if !snap.Unchanged || snap.Body != nil {
		t.Errorf("second fetch not Unchanged: %+v", snap)
	}
	if n := srv.hits["public/db/shruti.20260809133448.db"]; n != 1 {
		t.Errorf("catalog requests = %d, want 1", n)
	}
	if n := srv.hits[manifestKey]; n != 2 {
		t.Errorf("manifest requests = %d, want 2", n)
	}
}

// A 404 on either object, and a manifest advertising no database, are errors —
// never a silently empty catalog (which would look like "nothing published").
func TestHTTPFetcherNotFound(t *testing.T) {
	cases := []struct {
		name     string
		manifest string
		objects  map[string][]byte
		want     string
	}{
		{
			name:     "catalog object missing",
			manifest: `{"databases":[{"version":20260809133448}]}`,
			objects:  map[string][]byte{},
			want:     "shruti.20260809133448.db: status 404",
		},
		{
			name:     "manifest advertises no database",
			manifest: `{"databases":[]}`,
			want:     "advertises no catalog database",
		},
		{
			name:     "manifest is not json",
			manifest: `<!doctype html>`,
			want:     "decode public/config.json",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := &manifestServer{manifest: tc.manifest, objects: tc.objects, hits: map[string]int{}}
			ts := httptest.NewServer(http.HandlerFunc(srv.handler))
			defer ts.Close()
			_, err := NewHTTPFetcher(ts.URL).Fetch(context.Background(), "")
			if err == nil {
				t.Fatalf("want error containing %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

// A missing manifest is an error too (the pre-fix behaviour silently polled a
// key that never existed).
func TestHTTPFetcherManifestMissing(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()
	_, err := NewHTTPFetcher(ts.URL).Fetch(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "status 404") {
		t.Fatalf("err = %v, want a 404 on the manifest", err)
	}
}

// fakeBlob serves objects by key out of a map.
type fakeBlob struct {
	objects map[string][]byte
	gets    []string
}

func (b *fakeBlob) Get(_ context.Context, key string) ([]byte, error) {
	b.gets = append(b.gets, key)
	body, ok := b.objects[key]
	if !ok {
		return nil, fmt.Errorf("no such key %q", key)
	}
	return body, nil
}

// The blob branch resolves the version through the same manifest, so it asks
// the backend for the version-stamped key and never for a fixed filename.
func TestBlobFetcherResolvesLatestVersion(t *testing.T) {
	blob := catalogBytes(t, "trk-a")
	b := &fakeBlob{objects: map[string][]byte{
		manifestKey:                             []byte(`{"databases":[{"version":20260808132654},{"version":20260809133448}]}`),
		"public/db/shruti.20260809133448.db": blob,
	}}
	snap, err := NewBlobFetcher(b).Fetch(context.Background(), "")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if snap.Version != "20260809133448" || len(snap.Body) != len(blob) {
		t.Errorf("snapshot wrong: version=%q bytes=%d", snap.Version, len(snap.Body))
	}
	want := []string{manifestKey, "public/db/shruti.20260809133448.db"}
	if len(b.gets) != len(want) || b.gets[0] != want[0] || b.gets[1] != want[1] {
		t.Errorf("gets = %v, want %v", b.gets, want)
	}
}

// Unchanged version → the blob backend is never asked for the catalog object.
func TestBlobFetcherSkipsDownloadWhenVersionUnchanged(t *testing.T) {
	b := &fakeBlob{objects: map[string][]byte{
		manifestKey: []byte(`{"databases":[{"version":20260809133448}]}`),
	}}
	snap, err := NewBlobFetcher(b).Fetch(context.Background(), "20260809133448")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if !snap.Unchanged {
		t.Errorf("snapshot not Unchanged: %+v", snap)
	}
	if len(b.gets) != 1 || b.gets[0] != manifestKey {
		t.Errorf("gets = %v, want only the manifest", b.gets)
	}
}

// A missing manifest on the blob backend surfaces as an error.
func TestBlobFetcherManifestMissing(t *testing.T) {
	_, err := NewBlobFetcher(&fakeBlob{objects: map[string][]byte{}}).Fetch(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), manifestKey) {
		t.Fatalf("err = %v, want a missing-manifest error", err)
	}
}
