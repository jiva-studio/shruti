package storage

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBunnyListFilesReturnsTheFilesOfOneDirectory(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotKey = r.URL.Path, r.Header.Get("AccessKey")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `[
			{"ObjectName":"b.mp4","IsDirectory":false,"Length":10},
			{"ObjectName":"nested","IsDirectory":true,"Length":0},
			{"ObjectName":"a.mp4","IsDirectory":false,"Length":20}
		]`)
	}))
	defer srv.Close()

	b := NewBunny("zone", "secret", srv.URL)
	keys, err := b.ListFiles(t.Context(), "private/share/video/backgrounds/calm")
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if gotPath != "/zone/private/share/video/backgrounds/calm/" || gotKey != "secret" {
		t.Errorf("request path=%q key=%q", gotPath, gotKey)
	}
	want := []string{
		"private/share/video/backgrounds/calm/a.mp4",
		"private/share/video/backgrounds/calm/b.mp4",
	}
	if !reflect.DeepEqual(keys, want) {
		t.Errorf("keys = %v, want %v", keys, want)
	}
}

func TestBunnyListFilesOfAMissingDirectoryIsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	keys, err := NewBunny("zone", "secret", srv.URL).ListFiles(t.Context(), "private/none")
	if err != nil || len(keys) != 0 {
		t.Fatalf("got %v, %v; want no keys and no error", keys, err)
	}
}

func TestBunnyListFilesReportsAnUnexpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `[]`)
	}))
	defer srv.Close()
	if _, err := NewBunny("zone", "bad", srv.URL).ListFiles(t.Context(), "private/x"); err == nil {
		t.Fatal("a 401 listing was taken as an answer")
	}
}

func TestBunnyDownloadToWritesTheObject(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotKey = r.URL.Path, r.Header.Get("AccessKey")
		_, _ = io.WriteString(w, "mp3-bytes")
	}))
	defer srv.Close()

	dst := filepath.Join(t.TempDir(), "source.mp3")
	b := NewBunny("zone", "secret", srv.URL)
	if err := b.DownloadTo(t.Context(), "public/tracks/t/audio/original.mp3", dst); err != nil {
		t.Fatalf("DownloadTo: %v", err)
	}
	if gotPath != "/zone/public/tracks/t/audio/original.mp3" || gotKey != "secret" {
		t.Errorf("request path=%q key=%q", gotPath, gotKey)
	}
	body, err := os.ReadFile(dst)
	if err != nil || string(body) != "mp3-bytes" {
		t.Fatalf("file = %q, %v", body, err)
	}
}

func TestBunnyDownloadToFailsOnAMissingObject(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	dst := filepath.Join(t.TempDir(), "source.mp3")
	if err := NewBunny("zone", "secret", srv.URL).DownloadTo(t.Context(), "public/tracks/none.mp3", dst); err == nil {
		t.Fatal("a 404 download succeeded")
	}
}

func TestBunnyRefusesAKeyThatLeavesItsPath(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = io.WriteString(w, `[]`)
	}))
	defer srv.Close()
	b := NewBunny("zone", "secret", srv.URL)
	dst := filepath.Join(t.TempDir(), "x")
	for _, key := range []string{"public/../private/x", "../../x", "public/./x", "public//x", "/public/x", "", "public/x/.."} {
		if err := b.DownloadTo(t.Context(), key, dst); err == nil {
			t.Errorf("DownloadTo(%q) succeeded", key)
		}
		if err := b.Put(t.Context(), key, dst, "video/mp4"); err == nil {
			t.Errorf("Put(%q) succeeded", key)
		}
	}
	if _, err := b.ListFiles(t.Context(), "private/../x"); err == nil {
		t.Error("ListFiles on a relative directory succeeded")
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
	dst := filepath.Join(t.TempDir(), "x")
	if err := NewBunny("zone", "secret", srv.URL).DownloadTo(t.Context(), "public/a#b?c%2e/x y.mp3", dst); err == nil {
		t.Fatal("a 404 download succeeded")
	}
	if gotRawPath != "/zone/public/a%23b%3Fc%252e/x%20y.mp3" || gotQuery != "" {
		t.Fatalf("path=%q query=%q", gotRawPath, gotQuery)
	}
}

func TestBunnyPutUploadsTheFile(t *testing.T) {
	var gotMethod, gotPath, gotKey, gotType, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotMethod, gotPath, gotKey, gotType, gotBody = r.Method, r.URL.Path, r.Header.Get("AccessKey"), r.Header.Get("Content-Type"), string(body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	src := filepath.Join(t.TempDir(), "reel.mp4")
	if err := os.WriteFile(src, []byte("mp4-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewBunny("zone", "secret", srv.URL).Put(t.Context(), "public/share/video/v.mp4", src, "video/mp4"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/zone/public/share/video/v.mp4" || gotKey != "secret" || gotType != "video/mp4" || gotBody != "mp4-bytes" {
		t.Errorf("got %s %s key=%q type=%q body=%q", gotMethod, gotPath, gotKey, gotType, gotBody)
	}
}
