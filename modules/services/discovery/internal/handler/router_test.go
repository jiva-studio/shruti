package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/ask"
	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/handler"
	"github.com/jiva-studio/shruti/discovery/internal/metrics"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// The HTTP surface had no test at all. What it promises — a status code, a
// shape, and credentials that go in and never come back out — is exactly the
// sort of thing that changes by accident.
//
// Without SHRUTI_DISCOVERY_TEST_DATABASE_URL these skip. CI always sets it.
func testRouter(t *testing.T) (http.Handler, *store.Repo) {
	t.Helper()
	dsn := os.Getenv("SHRUTI_DISCOVERY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SHRUTI_DISCOVERY_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := store.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS discovery CASCADE`); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	repo := store.NewRepo(pool)
	searcher := &search.Service{Pool: pool}
	return handler.NewRouter(handler.RouterDeps{
		Pool:    pool,
		Repo:    repo,
		Search:  searcher,
		Ask:     &ask.Service{Searcher: searcher},
		Metrics: metrics.New(time.Now().UTC()),
	}), repo
}

func do(t *testing.T, h http.Handler, method, target, body string) (int, map[string]any) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	var out map[string]any
	if w.Body.Len() > 0 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s %s returned %q: %v", method, target, w.Body.String(), err)
		}
	}
	return w.Code, out
}

func TestHealthAndReadiness(t *testing.T) {
	h, _ := testRouter(t)

	if code, body := do(t, h, http.MethodGet, "/healthz", ""); code != http.StatusOK || body["status"] != "ok" {
		t.Errorf("healthz = %d %v", code, body)
	}
	// Readiness is not liveness: it gates traffic on the schema being current,
	// which is the whole reason migrate and serve are the same image.
	if code, body := do(t, h, http.MethodGet, "/readyz", ""); code != http.StatusOK || body["status"] != "ready" {
		t.Errorf("readyz = %d %v", code, body)
	}
}

// Credentials go in and never come back out — not from the write that set them,
// and not from the list.
func TestSourceCredentialsAreNeverReturned(t *testing.T) {
	h, repo := testRouter(t)

	code, body := do(t, h, http.MethodPost, "/discovery/sources", `{
		"id":"a","seed_urls":["https://a.example/"],
		"auth_headers":{"Cookie":"session=abc"}}`)
	if code != http.StatusOK {
		t.Fatalf("save = %d %v", code, body)
	}
	if _, ok := body["auth_headers"]; ok {
		t.Errorf("the write echoed the credentials back: %v", body["auth_headers"])
	}

	code, body = do(t, h, http.MethodGet, "/discovery/sources", "")
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, body)
	}
	if strings.Contains(mustJSON(t, body), "session=abc") {
		t.Error("the list gave the credentials away")
	}

	// They were stored, though — the point is that they do not come back, not
	// that they were dropped.
	src, err := repo.Source(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	if src.AuthHeaders["Cookie"] != "session=abc" {
		t.Errorf("stored credentials = %v", src.AuthHeaders)
	}
}

// The write surface is the list of fields the API declares, not the list of
// columns the table happens to have. Decoding straight into the row type made
// those the same thing, so every column added later became settable from
// outside without anyone deciding it should be.
func TestOnlyDeclaredFieldsAreSettable(t *testing.T) {
	h, repo := testRouter(t)

	code, body := do(t, h, http.MethodPost, "/discovery/sources", `{
		"id":"a","seed_urls":["https://a.example/"],
		"has_credentials":true,
		"url_key":"whatever","body_sha256":"deadbeef","norm_prompt_version":"v99"}`)
	if code != http.StatusOK {
		t.Fatalf("save = %d %v", code, body)
	}
	// Fields the API does not declare are ignored, not honoured and not an
	// error — a caller sending extra keys is not doing anything wrong.
	if body["has_credentials"] == true {
		t.Error("a caller talked the source into claiming it has credentials")
	}
	for _, key := range []string{"url_key", "body_sha256", "norm_prompt_version", "auth_headers"} {
		if _, ok := body[key]; ok {
			t.Errorf("%q reached the response; the shape follows the table, not the API", key)
		}
	}

	// What comes back is what was stored, defaults included, rather than an
	// echo of what was sent.
	src, err := repo.Source(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	if src.HasCredentials {
		t.Error("credentials appeared on a source that was given none")
	}
	if got, want := body["crawl_delay_ms"], float64(src.CrawlDelayMS); got != want {
		t.Errorf("crawl_delay_ms = %v, stored %v; the response echoed the request", got, want)
	}
}

// A source that does have credentials says so without saying what they are.
func TestASourceSaysWhetherItHasCredentials(t *testing.T) {
	h, _ := testRouter(t)

	if code, _ := do(t, h, http.MethodPost, "/discovery/sources", `{
		"id":"a","seed_urls":["https://a.example/"],
		"auth_headers":{"Cookie":"session=abc"}}`); code != http.StatusOK {
		t.Fatalf("save = %d", code)
	}
	code, body := do(t, h, http.MethodGet, "/discovery/sources", "")
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, body)
	}
	if !strings.Contains(mustJSON(t, body), `"has_credentials":true`) {
		t.Errorf("the list does not say the source is signed in: %s", mustJSON(t, body))
	}
}

func TestSourceNeedsAnIDAndASeed(t *testing.T) {
	h, _ := testRouter(t)
	for _, body := range []string{`{"seed_urls":["https://a.example/"]}`, `{"id":"a"}`, `{}`} {
		if code, _ := do(t, h, http.MethodPost, "/discovery/sources", body); code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", body, code)
		}
	}
}

// A body larger than the cap is refused rather than read. Every write path has
// one; without it a single request can decide how much memory this service uses.
func TestOversizedBodiesAreRefused(t *testing.T) {
	h, _ := testRouter(t)
	huge := `{"id":"a","title":"` + strings.Repeat("x", 2<<20) + `","seed_urls":["https://a.example/"]}`
	if code, _ := do(t, h, http.MethodPost, "/discovery/sources", huge); code != http.StatusBadRequest {
		t.Errorf("= %d, want 400", code)
	}
}

// A request id comes back on every response, made up when the caller did not
// bring one. It is what ties a log line to the request that caused it.
func TestEveryResponseCarriesARequestID(t *testing.T) {
	h, _ := testRouter(t)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Header().Get("X-Request-Id") == "" {
		t.Error("no request id on a response that minted one")
	}

	w = httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	r.Header.Set("X-Request-Id", "from-the-caller")
	h.ServeHTTP(w, r)
	if got := w.Header().Get("X-Request-Id"); got != "from-the-caller" {
		t.Errorf("request id = %q, want the caller's own", got)
	}
}

// The status endpoint is what replaced the run rows the scheduler stopped
// writing. An operator reads it to know whether anything is moving, so its
// shape is a promise.
func TestStatusReportsWorkAndQueue(t *testing.T) {
	h, _ := testRouter(t)

	code, body := do(t, h, http.MethodGet, "/discovery/status", "")
	if code != http.StatusOK {
		t.Fatalf("= %d %v", code, body)
	}
	if _, ok := body["queue"]; !ok {
		t.Error("no queue depth: an operator cannot tell whether anything is waiting")
	}
	work, ok := body["work"].(map[string]any)
	if !ok {
		t.Fatalf("work = %v", body["work"])
	}
	for _, field := range []string{
		"uptime_s", "pages_fetched", "pages_failed", "items_new",
		"model_calls", "cost_usd", "failures", "pages_per_minute",
	} {
		if _, ok := work[field]; !ok {
			t.Errorf("status is missing %q", field)
		}
	}
}

// Crawling is not wired in this router, so asking for it says so rather than
// panicking on a nil.
func TestUnwiredSubsystemsSaySo(t *testing.T) {
	h, _ := testRouter(t)
	if code, _ := do(t, h, http.MethodPost, "/discovery/sources", `{"id":"a","seed_urls":["https://a.example/"]}`); code != http.StatusOK {
		t.Fatal("could not create the source the next call needs")
	}
	if code, _ := do(t, h, http.MethodPost, "/discovery/sources/a/run", ""); code != http.StatusServiceUnavailable {
		t.Errorf("= %d, want 503 when crawling is not wired", code)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A question in words answers with the recordings, the filter it was read into,
// and the question itself unchanged — so the caller can drop a field and ask
// again without rewriting anything.
//
// Without a model configured, which is what these tests run with, the question
// is searched as written and a message says so. That is the degraded path, and
// it is the one that must not be a failure.
func TestAQuestionIsStillASearchWithoutAModel(t *testing.T) {
	h, _ := testRouter(t)

	code, body := do(t, h, http.MethodPost, "/discovery/search",
		`{"query":"лекции Шиварамы Свами за 2012 год о карме","filter":{"limit":5}}`)
	if code != http.StatusOK {
		t.Fatalf("= %d %v", code, body)
	}
	if body["query"] != "лекции Шиварамы Свами за 2012 год о карме" {
		t.Errorf("the question came back as %v", body["query"])
	}
	f, _ := body["filter"].(map[string]any)
	if f == nil || f["text"] != "лекции Шиварамы Свами за 2012 год о карме" {
		t.Errorf("filter = %v", body["filter"])
	}
	if f["limit"] != float64(5) {
		t.Errorf("the caller's own field was lost: %v", f["limit"])
	}
	if !strings.Contains(mustJSON(t, body), "not_read") {
		t.Errorf("nothing said the question was not read: %s", mustJSON(t, body))
	}
}

// A filter with no question is the plain search, in a body.
func TestAFilterAloneNeedsNoQuestion(t *testing.T) {
	h, _ := testRouter(t)
	code, body := do(t, h, http.MethodPost, "/discovery/search", `{"filter":{"authors":["Локанатха Свами"]}}`)
	if code != http.StatusOK {
		t.Fatalf("= %d %v", code, body)
	}
	// Nobody by that name is in an empty corpus, so this is the "nothing could
	// match" answer rather than the "nothing matches" one.
	if !strings.Contains(mustJSON(t, body), "matches_nobody") {
		t.Errorf("= %s", mustJSON(t, body))
	}
}

func TestAnEmptyAskIsRefused(t *testing.T) {
	h, _ := testRouter(t)
	if code, _ := do(t, h, http.MethodPost, "/discovery/search", `{}`); code != http.StatusBadRequest {
		t.Errorf("= %d, want 400", code)
	}
}
