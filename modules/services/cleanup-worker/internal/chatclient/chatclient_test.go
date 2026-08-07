package chatclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestClient(url, token string) *Client {
	return &Client{baseURL: url, token: token, httpClient: http.DefaultClient}
}

func TestPurgeLibrary_PostsTheUserAndTheToken(t *testing.T) {
	var gotPath, gotToken, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-App-Token")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"meta_rows":1,"chunks":9}`))
	}))
	defer srv.Close()

	if err := newTestClient(srv.URL, "t0ken").PurgeLibrary(context.Background(), "u-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotPath != "/internal/purge" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotToken != "t0ken" {
		t.Fatalf("token = %q — chat's internal routes are behind the app token", gotToken)
	}
	var body map[string]string
	if err := json.Unmarshal([]byte(gotBody), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body["user_id"] != "u-1" {
		t.Fatalf("body = %v", body)
	}
}

// Nothing to purge is not a failure; the outbox must not retry forever.
func TestPurgeLibrary_NotFoundIsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if err := newTestClient(srv.URL, "t").PurgeLibrary(context.Background(), "u-1"); err != nil {
		t.Fatalf("404 should count as purged: %v", err)
	}
}

func TestPurgeLibrary_ServerErrorRetriesThenFails(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	if err := newTestClient(srv.URL, "t").PurgeLibrary(context.Background(), "u-1"); err == nil {
		t.Fatal("a failed purge must surface so the outbox re-runs it")
	}
	if attempts != maxAttempts {
		t.Fatalf("attempts = %d, want %d", attempts, maxAttempts)
	}
}

// Deployment order again: an unset URL or token must not wedge the outbox on
// every deleted account.
func TestPurgeLibrary_UnconfiguredIsANoOp(t *testing.T) {
	for _, c := range []*Client{
		newTestClient("", "t"),
		newTestClient("http://chat:8000", ""),
		nil,
	} {
		if err := c.PurgeLibrary(context.Background(), "u-1"); err != nil {
			t.Fatalf("unconfigured client returned %v", err)
		}
	}
}

func TestPurgeLibrary_EmptyUserIsRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("must not call chat without a user id")
	}))
	defer srv.Close()

	if err := newTestClient(srv.URL, "t").PurgeLibrary(context.Background(), ""); err == nil {
		t.Fatal("expected an error for an empty user id")
	}
}
