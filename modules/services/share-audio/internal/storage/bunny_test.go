package storage

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBunnyExistsProbesTheStorageZone(t *testing.T) {
	cases := []struct {
		status int
		want   bool
	}{
		{http.StatusPartialContent, true},
		{http.StatusOK, true},
		{http.StatusNotFound, false},
	}
	for _, tc := range cases {
		var gotPath, gotKey, gotRange string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotPath, gotKey, gotRange = r.URL.Path, r.Header.Get("AccessKey"), r.Header.Get("Range")
			w.WriteHeader(tc.status)
		}))
		b := NewBunny("zone", "secret", srv.URL, "https://cdn.example.test")
		ok, err := b.Exists(t.Context(), "public/shares/audio/x.mp3")
		srv.Close()
		if err != nil {
			t.Fatalf("status %d: %v", tc.status, err)
		}
		if ok != tc.want {
			t.Errorf("status %d: exists = %v, want %v", tc.status, ok, tc.want)
		}
		if gotPath != "/zone/public/shares/audio/x.mp3" || gotKey != "secret" || gotRange != "bytes=0-0" {
			t.Errorf("request path=%q key=%q range=%q", gotPath, gotKey, gotRange)
		}
	}
}

func TestBunnyExistsReportsAnUnexpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	if _, err := NewBunny("zone", "bad", srv.URL, "https://cdn.example.test").Exists(t.Context(), "k"); err == nil {
		t.Fatal("a 401 was taken as an answer")
	}
}

func TestBunnyUploadPutsTheFile(t *testing.T) {
	var gotMethod, gotPath, gotKey, gotType, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotMethod, gotPath, gotKey, gotType, gotBody = r.Method, r.URL.Path, r.Header.Get("AccessKey"), r.Header.Get("Content-Type"), string(body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	src := filepath.Join(t.TempDir(), "x.mp3")
	if err := os.WriteFile(src, []byte("mp3-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := NewBunny("zone", "secret", srv.URL, "https://cdn.example.test")
	if err := b.Upload(t.Context(), "public/shares/audio/x.mp3", src, "audio/mpeg", ""); err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/zone/public/shares/audio/x.mp3" || gotKey != "secret" || gotType != "audio/mpeg" || gotBody != "mp3-bytes" {
		t.Errorf("got %s %s key=%q type=%q body=%q", gotMethod, gotPath, gotKey, gotType, gotBody)
	}
}

func TestBunnyBuildURLUsesThePullZone(t *testing.T) {
	b := NewBunny("zone", "secret", "", "https://cdn.example.test/")
	if got := b.BuildURL("public/tracks/t/audio/original.mp3"); got != "https://cdn.example.test/public/tracks/t/audio/original.mp3" {
		t.Fatalf("BuildURL = %q", got)
	}
}
