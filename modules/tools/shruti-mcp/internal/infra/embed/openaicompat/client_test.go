package openaicompatembed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestIsTimeoutClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"context deadline", context.DeadlineExceeded, true},
		{"wrapped context deadline", fmt.Errorf("decode response: %w", context.DeadlineExceeded), true},
		{"net timeout", timeoutErr{}, true},
		{"plain error", errors.New("boom"), false},
		{"json syntax", &json.SyntaxError{}, false},
	}
	for _, c := range cases {
		if got := isTimeout(c.err); got != c.want {
			t.Errorf("%s: isTimeout(%v) = %v, want %v", c.name, c.err, got, c.want)
		}
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

// A body-read timeout (the client Timeout firing mid-response) must be retried,
// not treated as terminal corruption — the previous behaviour failed the whole
// build on a single slow batch.
func TestEmbedRetriesBodyReadTimeout(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			// Send a partial body then stall past the client timeout so the
			// decode (body read) times out — exactly the failure mode in prod.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, `{"data":[`)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(300 * time.Millisecond)
			return
		}
		_ = json.NewEncoder(w).Encode(embedResponse{Data: []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		}{{Index: 0, Embedding: []float32{0.1, 0.2}}}})
	}))
	defer srv.Close()

	c, err := New(Config{Endpoint: srv.URL, Model: "test", Timeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	vecs, err := c.Embed(context.Background(), []string{"hello"})
	if err != nil {
		t.Fatalf("body-read timeout should be retried to success, got %v", err)
	}
	if len(vecs) != 1 || len(vecs[0]) != 2 {
		t.Fatalf("unexpected vectors: %v", vecs)
	}
	if got := atomic.LoadInt32(&calls); got < 2 {
		t.Fatalf("expected a retry (>=2 calls), got %d", got)
	}
}

// A genuine context cancellation must NOT be swallowed by the retry loop.
func TestEmbedHonorsContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
	}))
	defer srv.Close()

	c, err := New(Config{Endpoint: srv.URL, Model: "test", Timeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := c.Embed(ctx, []string{"hello"}); err == nil {
		t.Fatal("expected error when ctx is cancelled")
	}
}
