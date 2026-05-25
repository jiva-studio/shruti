package observability

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

// fakeLangfuse simulates pagination + batch-delete. It serves three pages
// (100, 100, 30 traces) so the iteration must walk past the first response
// AND stop on the short page.
type fakeLangfuse struct {
	mu          sync.Mutex
	wantUser    string
	wantUser2   string
	gets        int
	deletes     int
	deletedIDs  []string
	authHeaders []string
	pages       map[string][][]string // userId → list of pages, each = []id
}

func newFake(userID string, pageCount int, lastPageSize int) *fakeLangfuse {
	f := &fakeLangfuse{
		wantUser: userID,
		pages:    map[string][][]string{},
	}
	pages := make([][]string, 0, pageCount)
	id := 0
	for p := 0; p < pageCount; p++ {
		size := pageSize
		if p == pageCount-1 {
			size = lastPageSize
		}
		page := make([]string, 0, size)
		for i := 0; i < size; i++ {
			page = append(page, fmt.Sprintf("tr-%d", id))
			id++
		}
		pages = append(pages, page)
	}
	f.pages[userID] = pages
	return f
}

func (f *fakeLangfuse) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/public/traces", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if h := r.Header.Get("Authorization"); h != "" {
			f.authHeaders = append(f.authHeaders, h)
		}
		switch r.Method {
		case http.MethodGet:
			f.gets++
			userID := r.URL.Query().Get("userId")
			pageStr := r.URL.Query().Get("page")
			page, _ := strconv.Atoi(pageStr)
			if page < 1 {
				page = 1
			}
			pages, ok := f.pages[userID]
			var ids []string
			if ok && page-1 < len(pages) {
				ids = pages[page-1]
			}
			data := make([]map[string]string, 0, len(ids))
			for _, id := range ids {
				data = append(data, map[string]string{"id": id})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
		case http.MethodDelete:
			f.deletes++
			var body struct {
				TraceIDs []string `json:"traceIds"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			f.deletedIDs = append(f.deletedIDs, body.TraceIDs...)
			w.WriteHeader(http.StatusOK)
		default:
			http.Error(w, "method", 405)
		}
	})
	return mux
}

func TestPurgeUserTraces_PaginationAndBatchDelete(t *testing.T) {
	const user = "user-123"
	fake := newFake(user, 3, 30) // 100 + 100 + 30 = 230 traces
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	client := &LangfuseClient{
		host:       srv.URL,
		publicKey:  "pk-test",
		secretKey:  "sk-test",
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}

	if err := client.PurgeUserTraces(context.Background(), user); err != nil {
		t.Fatalf("purge: %v", err)
	}

	// Pages: should fetch 3 pages (third returns < pageSize → stop).
	if fake.gets != 3 {
		t.Errorf("expected 3 GET calls, got %d", fake.gets)
	}
	// Deletes: 230 / 50 = 5 batches.
	if fake.deletes != 5 {
		t.Errorf("expected 5 DELETE calls, got %d", fake.deletes)
	}
	if len(fake.deletedIDs) != 230 {
		t.Errorf("expected 230 deleted ids, got %d", len(fake.deletedIDs))
	}
	// Basic auth applied on every call.
	if len(fake.authHeaders) != fake.gets+fake.deletes {
		t.Errorf("expected auth header on every call, got %d / %d",
			len(fake.authHeaders), fake.gets+fake.deletes)
	}
}

func TestPurgeUserTraces_EmptyResultIsNoOp(t *testing.T) {
	fake := newFake("user-x", 0, 0) // no pages → empty first response
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	client := &LangfuseClient{
		host:       srv.URL,
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}
	if err := client.PurgeUserTraces(context.Background(), "user-x"); err != nil {
		t.Fatalf("purge empty: %v", err)
	}
	if fake.gets != 1 {
		t.Errorf("empty result should require exactly 1 GET, got %d", fake.gets)
	}
	if fake.deletes != 0 {
		t.Errorf("empty result must not DELETE, got %d", fake.deletes)
	}
}

func TestPurgeUserTraces_UnconfiguredReturnsNil(t *testing.T) {
	client := &LangfuseClient{} // empty host
	if err := client.PurgeUserTraces(context.Background(), "user-y"); err != nil {
		t.Errorf("unconfigured purge must return nil, got %v", err)
	}
}

func TestPurgeUserTraces_PropagatesHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := &LangfuseClient{
		host:       srv.URL,
		httpClient: &http.Client{Timeout: 2 * time.Second},
	}
	if err := client.PurgeUserTraces(context.Background(), "user-z"); err == nil {
		t.Fatal("expected error from 500 response")
	}
}

func TestPurgeUserTraces_EmptyUserIDRejected(t *testing.T) {
	client := &LangfuseClient{host: "http://example.invalid"}
	if err := client.PurgeUserTraces(context.Background(), ""); err == nil {
		t.Fatal("expected error for empty user id")
	}
}

// Sanity: the fake handler can be hit directly — guards against the test
// helper drifting from real shape.
func TestFakeLangfuse_GETShapeMatches(t *testing.T) {
	fake := newFake("u", 1, 3)
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/public/traces?userId=u&page=1&limit=100")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var p tracesPage
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(p.Data) != 3 {
		t.Errorf("expected 3 data items, got %d (body=%s)", len(p.Data), string(body))
	}
}
