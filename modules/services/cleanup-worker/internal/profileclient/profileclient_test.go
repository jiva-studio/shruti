package profileclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(baseURL string) *Client {
	return &Client{
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
}

func TestPurgeUser_PostsUserIDToPurgeEndpoint(t *testing.T) {
	var gotPath, gotMethod, gotUserID, gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotContentType = r.Header.Get("Content-Type")
		var body purgeRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		gotUserID = body.UserID
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	err := newTestClient(srv.URL).PurgeUser(context.Background(), "user-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method: got %q want POST", gotMethod)
	}
	if gotPath != purgePath {
		t.Errorf("path: got %q want %q", gotPath, purgePath)
	}
	if gotContentType != "application/json" {
		t.Errorf("content-type: got %q", gotContentType)
	}
	if gotUserID != "user-123" {
		t.Errorf("user_id: got %q want user-123", gotUserID)
	}
}

func TestPurgeUser_TreatsNotFoundAsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if err := newTestClient(srv.URL).PurgeUser(context.Background(), "u"); err != nil {
		t.Fatalf("404 should be treated as success (idempotent no-op), got %v", err)
	}
}

func TestPurgeUser_ReturnsErrorOnServerFailure(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	err := newTestClient(srv.URL).PurgeUser(context.Background(), "u")
	if err == nil {
		t.Fatal("expected error on 503 so the outbox retries the handler")
	}
	if got := atomic.LoadInt32(&calls); got != maxAttempts {
		t.Errorf("expected %d in-call attempts, server saw %d", maxAttempts, got)
	}
}

func TestPurgeUser_UnconfiguredIsNoOp(t *testing.T) {
	c := &Client{baseURL: "", httpClient: &http.Client{}}
	if err := c.PurgeUser(context.Background(), "u"); err != nil {
		t.Fatalf("unconfigured client should be a no-op, got %v", err)
	}
}

func TestPurgeUser_EmptyUserIDIsError(t *testing.T) {
	if err := newTestClient("http://profile:8085").PurgeUser(context.Background(), ""); err == nil {
		t.Fatal("empty user id should be rejected")
	}
}

func TestNewClientFromEnv_TrimsTrailingSlash(t *testing.T) {
	t.Setenv("PROFILE_INTERNAL_URL", "http://profile:8085/")
	if got := NewClientFromEnv().baseURL; got != "http://profile:8085" {
		t.Errorf("baseURL: got %q want trimmed", got)
	}
}
