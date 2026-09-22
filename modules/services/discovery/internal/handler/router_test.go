package handler_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"

	"github.com/jiva-studio/lectorium/discovery/internal/application/ask"
	"github.com/jiva-studio/lectorium/discovery/internal/application/search"
	"github.com/jiva-studio/lectorium/discovery/internal/handler"
	"github.com/jiva-studio/lectorium/discovery/internal/infra/authjwt"
	"github.com/jiva-studio/lectorium/discovery/internal/metrics"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// One signer for the whole package. The routes care that a token came from the
// deployment's signer, never which key that is.
var testKey = func() *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return k
}()

// testBearer is an ACCESS token that signer would issue: aud="chat", as auth
// stamps it. A refresh token carries aud="auth" and is rejected.
var testBearer = func() string {
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, gjwt.RegisteredClaims{
		Subject:   "user-1",
		Audience:  gjwt.ClaimStrings{"chat"},
		ExpiresAt: gjwt.NewNumericDate(time.Now().Add(time.Hour)),
	})
	tok.Header["kid"] = "v1"
	s, err := tok.SignedString(testKey)
	if err != nil {
		panic(err)
	}
	return s
}()

// testVerifier hands the public half over the way a deployment does — as a file.
func testVerifier(t *testing.T) *authjwt.Verifier {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&testKey.PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	path := filepath.Join(t.TempDir(), "public.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatalf("write public key: %v", err)
	}
	v, err := authjwt.NewFromFile(path)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return v
}

// The HTTP surface had no test at all. What it promises — a status code, a
// shape, and credentials that go in and never come back out — is exactly the
// sort of thing that changes by accident.
//
// Without LECTORIUM_DISCOVERY_TEST_DATABASE_URL these skip. CI always sets it.
func testRouter(t *testing.T) (http.Handler, *store.Repo) {
	t.Helper()
	dsn := os.Getenv("LECTORIUM_DISCOVERY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("LECTORIUM_DISCOVERY_TEST_DATABASE_URL not set")
	}
	ctx := t.Context()
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
		Pool:     pool,
		Repo:     repo,
		Ask:      &ask.Service{Searcher: searcher},
		Metrics:  metrics.New(time.Now().UTC()),
		Verifier: testVerifier(t),
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
	// Only /discovery/search reads it; the rest are indifferent.
	r.Header.Set("Authorization", "Bearer "+testBearer)
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
	src, err := repo.Source(t.Context(), "a")
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
	src, err := repo.Source(t.Context(), "a")
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

// A browser will not send a POST carrying JSON until it has been told, in a
// preflight, that it may. Without an answer to that the client never reaches
// the service and the browser reports a network failure, which is the one
// explanation that is not true.
func TestABrowserMayAsk(t *testing.T) {
	h, _ := testRouter(t)

	req := httptest.NewRequest(http.MethodOptions, "/discovery/search", nil)
	req.Header.Set("Origin", "null")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("allow-origin = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(strings.ToLower(got), "content-type") {
		t.Errorf("allow-headers = %q; a JSON body needs Content-Type allowed", got)
	}

	// And the answer itself carries it, or the browser hides the body it just
	// fetched.
	post := httptest.NewRequest(http.MethodPost, "/discovery/search", strings.NewReader(`{"query":"x"}`))
	post.Header.Set("Origin", "null")
	post.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, post)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("the answer did not say who may read it: %q", got)
	}

	// Nothing is granted to an origin that did not ask.
	plain := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, plain)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("a request with no Origin was answered with %q", got)
	}
}

// Every /discovery route asks who is calling. Search is the one Caddy
// publishes; the rest were internal-only, which is a property of the
// deployment and not of the service. These need no database: the gate answers
// before anything is looked up, which is the property being checked.
func gateRouter(v *authjwt.Verifier) http.Handler {
	return handler.NewRouter(handler.RouterDeps{Ask: &ask.Service{}, Verifier: v})
}

func askSearch(h http.Handler, bearer string) int {
	r := httptest.NewRequest(http.MethodPost, "/discovery/search", strings.NewReader(`{"query":"health"}`))
	r.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}

func TestSearchNeedsAToken(t *testing.T) {
	h := gateRouter(testVerifier(t))
	if code := askSearch(h, ""); code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d, want 401", code)
	}
	if code := askSearch(h, "not-a-token"); code != http.StatusUnauthorized {
		t.Fatalf("junk token: got %d, want 401", code)
	}
}

// A key that was never configured must close the route, not open it. The
// service is otherwise internal; this one address is not, and answering
// unauthenticated because nobody finished the deployment is how a corpus and an
// embedding budget become public.
func TestSearchRefusesWhenNoKeyIsConfigured(t *testing.T) {
	if code := askSearch(gateRouter(nil), testBearer); code != http.StatusServiceUnavailable {
		t.Fatalf("nil verifier: got %d, want 503", code)
	}
}

// A token this signer did not issue is no token at all.
func TestSearchRejectsAForeignSigner(t *testing.T) {
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, gjwt.RegisteredClaims{
		Subject:   "user-1",
		Audience:  gjwt.ClaimStrings{"chat"},
		ExpiresAt: gjwt.NewNumericDate(time.Now().Add(time.Hour)),
	})
	tok.Header["kid"] = "v1"
	signed, err := tok.SignedString(other)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if code := askSearch(gateRouter(testVerifier(t)), signed); code != http.StatusUnauthorized {
		t.Fatalf("foreign signer: got %d, want 401", code)
	}
}


// /parse fetches a caller-chosen URL and lends it a stored source's
// credentials, and /items writes to the index. Neither may answer an
// unauthenticated caller just because it has no route at the edge today.
func TestInternalRoutesNeedAToken(t *testing.T) {
	h := gateRouter(testVerifier(t))
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/discovery/parse", `{"url":"https://example.com/x"}`},
		{http.MethodPost, "/discovery/items", `{"url":"https://example.com/x"}`},
		{http.MethodGet, "/discovery/status", ""},
		{http.MethodGet, "/discovery/sources", ""},
		{http.MethodPost, "/discovery/sources", `{}`},
		{http.MethodGet, "/discovery/runs", ""},
		{http.MethodGet, "/discovery/queue", ""},
		{http.MethodGet, "/discovery/authors", ""},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("got %d, want 401", w.Code)
			}
		})
	}
}

// Liveness and readiness stay open — they carry no data and the platform
// polls them without a credential.
func TestHealthRoutesStayOpen(t *testing.T) {
	h := gateRouter(testVerifier(t))
	r := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("healthz got %d, want 200", w.Code)
	}
}

// A refresh token lives 90 days and is revoked only in auth's own database,
// which this service never consults. It must not open a route here.
func TestRefreshAudienceIsRejected(t *testing.T) {
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, gjwt.RegisteredClaims{
		Subject:   "user-1",
		Audience:  gjwt.ClaimStrings{"auth"},
		ExpiresAt: gjwt.NewNumericDate(time.Now().Add(90 * 24 * time.Hour)),
	})
	tok.Header["kid"] = "v1"
	signed, err := tok.SignedString(testKey)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if code := askSearch(gateRouter(testVerifier(t)), signed); code != http.StatusUnauthorized {
		t.Fatalf("refresh token: got %d, want 401", code)
	}
}
