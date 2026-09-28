package imagefetch_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/ingest/internal/infra/imagefetch"
)

func TestFetchImageReturnsTheBodyAndItsType(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/webp")
		_, _ = w.Write([]byte("picture"))
	}))
	defer srv.Close()

	body, ctype, err := imagefetch.New(0, 0).FetchImage(t.Context(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "picture" || ctype != "image/webp" {
		t.Errorf("got %q as %q", body, ctype)
	}
}

func TestFetchImageRefusesAnythingButOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	defer srv.Close()

	_, _, err := imagefetch.New(0, 0).FetchImage(t.Context(), srv.URL)
	if err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("err = %v, want the status named", err)
	}
}

func TestFetchImageReadsNoMoreThanItsCap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 100)))
	}))
	defer srv.Close()

	body, _, err := imagefetch.New(0, 10).FetchImage(t.Context(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != 10 {
		t.Errorf("read %d bytes, want the cap of 10", len(body))
	}
}

func TestFetchImageGivesUpAtItsTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	start := time.Now()
	_, _, err := imagefetch.New(50*time.Millisecond, 0).FetchImage(t.Context(), srv.URL)
	if err == nil {
		t.Fatal("a server that never answers was not given up on")
	}
	if waited := time.Since(start); waited > 5*time.Second {
		t.Errorf("waited %v for a 50ms timeout", waited)
	}
}
