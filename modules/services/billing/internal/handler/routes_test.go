package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/authjwt"
	"github.com/jiva-studio/shruti/billing/internal/authclient"
	"github.com/jiva-studio/shruti/billing/internal/driver"
	"github.com/jiva-studio/shruti/billing/internal/paymento"
	"github.com/jiva-studio/shruti/billing/internal/store"
)

// routeEnv is what a black-box route test configures: the database (nil for
// none), the two upstreams, the webhook secret and the token verifier.
type routeEnv struct {
	pool        *pgxpool.Pool
	paymentoURL string
	paymentoKey string
	authURL     string
	hmacSecret  string
	verifier    *authjwt.Verifier
}

// newRouteRouter builds the service's router the way main wires it.
func newRouteRouter(t *testing.T, e routeEnv) http.Handler {
	t.Helper()
	pmt := paymento.New(e.paymentoURL, e.paymentoKey)
	h := &BillingHandler{
		Verifier:      e.verifier,
		Paymento:      pmt,
		PublicBaseURL: "https://example.test",
		HMACSecret:    e.hmacSecret,
	}
	if e.pool != nil {
		repo := &store.Repo{Pool: e.pool}
		h.Repo = repo
		h.Driver = &driver.Driver{Pool: e.pool, Repo: repo, Paymento: pmt, Auth: authclient.New(e.authURL, "internal-token")}
	}
	return NewRouter(h)
}

type routeResp struct {
	code   int
	body   map[string]any
	header http.Header
}

func call(t *testing.T, h http.Handler, method, path, body string, headers map[string]string) routeResp {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	out := routeResp{code: rec.Code, header: rec.Header()}
	if rec.Header().Get("Content-Type") == "application/json" {
		if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
			t.Fatalf("%s %s: body is not a JSON object: %q", method, path, rec.Body.String())
		}
	}
	return out
}

func errBody(code, msg string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": msg}}
}

func wantResp(t *testing.T, got routeResp, code int, body map[string]any) {
	t.Helper()
	if got.code != code {
		t.Fatalf("status %d, want %d (body %v)", got.code, code, got.body)
	}
	if !reflect.DeepEqual(got.body, body) {
		t.Fatalf("body %v, want %v", got.body, body)
	}
}

func TestHealthzShape(t *testing.T) {
	for name, h := range map[string]http.Handler{
		"wired":    newRouteRouter(t, routeEnv{}),
		"nil deps": NewRouter(nil),
	} {
		t.Run(name, func(t *testing.T) {
			got := call(t, h, http.MethodGet, "/billing/healthz", "", nil)
			wantResp(t, got, http.StatusOK, map[string]any{
				"status": "ok",
				"build":  map[string]any{"sha": buildSHA, "time": buildTime},
			})
			if got.header.Get("Content-Type") != "application/json" {
				t.Errorf("content-type %q", got.header.Get("Content-Type"))
			}
		})
	}
}

func TestNilDepsServeOnlyHealthz(t *testing.T) {
	h := NewRouter(nil)
	if got := call(t, h, http.MethodPost, "/billing/checkout", `{}`, nil); got.code != http.StatusNotFound {
		t.Fatalf("checkout without deps: %d, want 404", got.code)
	}
	if got := call(t, h, http.MethodPost, "/webhooks/paymento", `{}`, nil); got.code != http.StatusNotFound {
		t.Fatalf("webhook without deps: %d, want 404", got.code)
	}
}

func TestRequestIDIsEchoedOrMinted(t *testing.T) {
	h := newRouteRouter(t, routeEnv{})
	got := call(t, h, http.MethodGet, "/billing/healthz", "", map[string]string{"X-Request-Id": "req-42"})
	if got.header.Get("X-Request-Id") != "req-42" {
		t.Fatalf("X-Request-Id %q, want req-42", got.header.Get("X-Request-Id"))
	}
	got = call(t, h, http.MethodGet, "/billing/healthz", "", nil)
	if _, err := uuid.Parse(got.header.Get("X-Request-Id")); err != nil {
		t.Fatalf("minted X-Request-Id %q is not a uuid", got.header.Get("X-Request-Id"))
	}
}

func TestCheckoutRefusals(t *testing.T) {
	v, mint := testKeys(t)
	h := newRouteRouter(t, routeEnv{verifier: v})
	bearer := func(anon bool) map[string]string {
		return map[string]string{"Authorization": "Bearer " + mint(uuid.NewString(), anon)}
	}

	wantResp(t, call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"monthly"}`, nil),
		http.StatusUnauthorized, errBody("missing_token", "Authorization header required"))
	if got := call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"monthly"}`,
		map[string]string{"Authorization": "Bearer junk"}); got.code != http.StatusUnauthorized ||
		got.body["error"].(map[string]any)["code"] != "invalid_token" {
		t.Fatalf("junk token: %d %v", got.code, got.body)
	}
	wantResp(t, call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"monthly"}`, bearer(true)),
		http.StatusForbidden, errBody("anonymous_forbidden", "sign in to purchase"))
	wantResp(t, call(t, h, http.MethodPost, "/billing/checkout", `not json`, bearer(false)),
		http.StatusBadRequest, errBody("bad_request", "invalid body"))
	wantResp(t, call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"weekly"}`, bearer(false)),
		http.StatusBadRequest, errBody("bad_plan", "plan must be 'monthly' or 'yearly'"))
	wantResp(t, call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"monthly"}`, bearer(false)),
		http.StatusServiceUnavailable, errBody("paymento_unconfigured", "payments are not available"))
}

func TestCheckoutRateLimitsPerUser(t *testing.T) {
	v, mint := testKeys(t)
	h := newRouteRouter(t, routeEnv{verifier: v})
	auth := map[string]string{"Authorization": "Bearer " + mint(uuid.NewString(), false)}
	for i := 0; i < 5; i++ {
		if got := call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"weekly"}`, auth); got.code != http.StatusBadRequest {
			t.Fatalf("attempt %d: %d, want 400", i+1, got.code)
		}
	}
	wantResp(t, call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"weekly"}`, auth),
		http.StatusTooManyRequests, errBody("rate_limited", "too many checkout attempts; retry later"))
	other := map[string]string{"Authorization": "Bearer " + mint(uuid.NewString(), false)}
	if got := call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"weekly"}`, other); got.code != http.StatusBadRequest {
		t.Fatalf("another user: %d, want 400", got.code)
	}
}

// paymentoCreate serves /v1/payment/request with status and body, recording
// the decoded request.
func paymentoCreate(t *testing.T, status int, body string, seen *map[string]any) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/payment/request" {
			t.Errorf("unexpected paymento path %s", r.URL.Path)
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read: %v", err)
		}
		if seen != nil {
			if err := json.Unmarshal(raw, seen); err != nil {
				t.Errorf("decode paymento request: %v", err)
			}
		}
		w.WriteHeader(status)
		if _, err := w.Write([]byte(body)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

type orderRow struct {
	userID      uuid.UUID
	plan        string
	amountCents int
	currency    string
	token       string
	status      string
	attempts    int
	lastError   string
}

func readOrder(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) orderRow {
	t.Helper()
	var o orderRow
	err := pool.QueryRow(t.Context(), `SELECT user_id, plan, amount_cents, currency,
		COALESCE(paymento_token,''), status, attempts, COALESCE(last_error,'')
		FROM billing.orders WHERE id = $1`, id).
		Scan(&o.userID, &o.plan, &o.amountCents, &o.currency, &o.token, &o.status, &o.attempts, &o.lastError)
	if err != nil {
		t.Fatalf("read order %s: %v", id, err)
	}
	return o
}

func ordersOf(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) []uuid.UUID {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT id FROM billing.orders WHERE user_id = $1`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids
}

func TestCheckoutCreatesOrderAndRedirects(t *testing.T) {
	pool := testPool(t)
	v, mint := testKeys(t)
	var seen map[string]any
	h := newRouteRouter(t, routeEnv{
		pool:        pool,
		verifier:    v,
		paymentoURL: paymentoCreate(t, http.StatusOK, `{"success":true,"message":null,"body":"tok-1"}`, &seen),
		paymentoKey: "k",
	})
	user := uuid.New()
	auth := map[string]string{"Authorization": "Bearer " + mint(user.String(), false)}

	got := call(t, h, http.MethodPost, "/billing/checkout",
		`{"plan":"yearly","returnPath":"/en/subscribe/success"}`, auth)
	wantResp(t, got, http.StatusOK, map[string]any{"redirectUrl": "https://app.paymento.io/gateway?token=tok-1"})

	ids := ordersOf(t, pool, user)
	if len(ids) != 1 {
		t.Fatalf("orders for user: %d, want 1", len(ids))
	}
	o := readOrder(t, pool, ids[0])
	if o.plan != "yearly" || o.amountCents != 2999 || o.currency != "USD" || o.token != "tok-1" || o.status != "created" || o.attempts != 0 {
		t.Fatalf("order row %+v", o)
	}
	if seen["fiatAmount"] != "29.99" || seen["fiatCurrency"] != "USD" || seen["orderId"] != ids[0].String() {
		t.Fatalf("paymento request %v", seen)
	}
	if seen["ReturnUrl"] != "https://example.test/en/subscribe/success?order="+ids[0].String() {
		t.Fatalf("ReturnUrl %v", seen["ReturnUrl"])
	}
	additional := map[string]any{}
	for _, kv := range seen["additionalData"].([]any) {
		m := kv.(map[string]any)
		additional[m["key"].(string)] = m["value"]
	}
	if !reflect.DeepEqual(additional, map[string]any{"userId": user.String(), "plan": "yearly"}) {
		t.Fatalf("additionalData %v", additional)
	}
}

func TestCheckoutFallsBackToDefaultReturnPath(t *testing.T) {
	pool := testPool(t)
	v, mint := testKeys(t)
	var seen map[string]any
	h := newRouteRouter(t, routeEnv{
		pool:        pool,
		verifier:    v,
		paymentoURL: paymentoCreate(t, http.StatusOK, `{"success":true,"body":"tok-2"}`, &seen),
		paymentoKey: "k",
	})
	user := uuid.New()
	got := call(t, h, http.MethodPost, "/billing/checkout",
		`{"plan":"monthly","returnPath":"https://evil.test/subscribe/success"}`,
		map[string]string{"Authorization": "Bearer " + mint(user.String(), false)})
	if got.code != http.StatusOK {
		t.Fatalf("status %d", got.code)
	}
	ids := ordersOf(t, pool, user)
	if len(ids) != 1 || seen["ReturnUrl"] != "https://example.test/subscribe/success?order="+ids[0].String() {
		t.Fatalf("ReturnUrl %v", seen["ReturnUrl"])
	}
}

func TestCheckoutGatewayFailureRecordsAttempt(t *testing.T) {
	pool := testPool(t)
	v, mint := testKeys(t)
	for name, url := range map[string]string{
		"gateway 500":      paymentoCreate(t, http.StatusInternalServerError, `boom`, nil),
		"gateway declines": paymentoCreate(t, http.StatusOK, `{"success":false,"message":"no"}`, nil),
	} {
		t.Run(name, func(t *testing.T) {
			h := newRouteRouter(t, routeEnv{pool: pool, verifier: v, paymentoURL: url, paymentoKey: "k"})
			user := uuid.New()
			wantResp(t, call(t, h, http.MethodPost, "/billing/checkout", `{"plan":"monthly"}`,
				map[string]string{"Authorization": "Bearer " + mint(user.String(), false)}),
				http.StatusBadGateway, errBody("paymento_error", "could not start payment"))
			ids := ordersOf(t, pool, user)
			if len(ids) != 1 {
				t.Fatalf("orders %d, want 1", len(ids))
			}
			o := readOrder(t, pool, ids[0])
			if o.status != "created" || o.attempts != 1 || !strings.HasPrefix(o.lastError, "create: paymento: ") {
				t.Fatalf("order row %+v", o)
			}
		})
	}
}

func signedIPN(body string) map[string]string {
	return map[string]string{"X-HMAC-SHA256-SIGNATURE": sign([]byte(body), hmacSecret)}
}

func TestWebhookRefusals(t *testing.T) {
	wantResp(t, call(t, newRouteRouter(t, routeEnv{}), http.MethodPost, "/webhooks/paymento", `{}`, nil),
		http.StatusServiceUnavailable, errBody("webhook_unconfigured", "webhook secret not set"))

	h := newRouteRouter(t, routeEnv{hmacSecret: hmacSecret})
	wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", `{"OrderId":"x"}`,
		map[string]string{"X-HMAC-SHA256-SIGNATURE": "BAD"}),
		http.StatusUnauthorized, errBody("bad_signature", "invalid signature"))
	wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", `{"OrderId":"x"}`, nil),
		http.StatusUnauthorized, errBody("bad_signature", "invalid signature"))

	const notJSON = `not json`
	wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", notJSON, signedIPN(notJSON)),
		http.StatusOK, map[string]any{"ok": false})
	const badOrder = `{"OrderId":"not-a-uuid","OrderStatus":8}`
	wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", badOrder, signedIPN(badOrder)),
		http.StatusOK, map[string]any{"ok": false})
}

func insertOrder(t *testing.T, pool *pgxpool.Pool, status, token, paymentID string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(t.Context(), `INSERT INTO billing.orders
		(user_id, plan, amount_cents, currency, status, paymento_token, paymento_payment_id)
		VALUES ($1, 'monthly', 299, 'USD', $2, NULLIF($3,''), NULLIF($4,'')) RETURNING id`,
		uuid.New(), status, token, paymentID).Scan(&id)
	if err != nil {
		t.Fatalf("insert order: %v", err)
	}
	return id
}

// upstreams serves Paymento verify (Approve) and the auth grant, counting both.
func upstreams(t *testing.T, paymentID string) (paymentoURL, authURL string, verifies, grants *int32) {
	t.Helper()
	verifies, grants = new(int32), new(int32)
	pmt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(verifies, 1)
		if _, err := w.Write([]byte(`{"orderStatus":"8","paymentId":"` + paymentID + `"}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(pmt.Close)
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(grants, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(auth.Close)
	return pmt.URL, auth.URL, verifies, grants
}

func TestWebhookDrivesOrderToFulfilled(t *testing.T) {
	pool := testPool(t)
	paymentID := uuid.NewString()
	pURL, aURL, verifies, grants := upstreams(t, paymentID)
	h := newRouteRouter(t, routeEnv{pool: pool, paymentoURL: pURL, paymentoKey: "k", authURL: aURL, hmacSecret: hmacSecret})
	id := insertOrder(t, pool, "created", "tok", "")

	body := `{"Token":"tok","PaymentId":"` + paymentID + `","OrderId":"` + id.String() + `","OrderStatus":8}`
	wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", body, signedIPN(body)),
		http.StatusOK, map[string]any{"ok": true})
	if o := readOrder(t, pool, id); o.status != "fulfilled" {
		t.Fatalf("status %q, want fulfilled", o.status)
	}
	if atomic.LoadInt32(verifies) != 1 || atomic.LoadInt32(grants) != 1 {
		t.Fatalf("verifies=%d grants=%d, want 1/1", *verifies, *grants)
	}

	wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", body, signedIPN(body)),
		http.StatusOK, map[string]any{"ok": true, "duplicate": true})
	if atomic.LoadInt32(verifies) != 1 || atomic.LoadInt32(grants) != 1 {
		t.Fatalf("duplicate reached upstreams: verifies=%d grants=%d", *verifies, *grants)
	}
}

func TestWebhookNegativeStatusDoesNotDrive(t *testing.T) {
	pool := testPool(t)
	pURL, aURL, verifies, grants := upstreams(t, uuid.NewString())
	h := newRouteRouter(t, routeEnv{pool: pool, paymentoURL: pURL, paymentoKey: "k", authURL: aURL, hmacSecret: hmacSecret})
	for _, status := range []string{"4", "5", "9"} {
		id := insertOrder(t, pool, "created", "tok", "")
		body := `{"OrderId":"` + id.String() + `","OrderStatus":` + status + `}`
		wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", body, signedIPN(body)),
			http.StatusOK, map[string]any{"ok": true})
		if o := readOrder(t, pool, id); o.status != "created" || o.attempts != 0 {
			t.Fatalf("status %s moved the order: %+v", status, o)
		}
	}
	if atomic.LoadInt32(verifies) != 0 || atomic.LoadInt32(grants) != 0 {
		t.Fatalf("verifies=%d grants=%d, want 0/0", *verifies, *grants)
	}
}

// A drive that fails upstream is still acknowledged; the order waits for the
// reconcile worker with the failure recorded.
func TestWebhookAcksWhenDriveFails(t *testing.T) {
	pool := testPool(t)
	pmt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(pmt.Close)
	h := newRouteRouter(t, routeEnv{pool: pool, paymentoURL: pmt.URL, paymentoKey: "k", hmacSecret: hmacSecret})
	id := insertOrder(t, pool, "created", "tok", "")

	body := `{"OrderId":"` + id.String() + `","OrderStatus":8}`
	wantResp(t, call(t, h, http.MethodPost, "/webhooks/paymento", body, signedIPN(body)),
		http.StatusOK, map[string]any{"ok": true})
	if o := readOrder(t, pool, id); o.status != "created" || o.attempts != 1 || !strings.HasPrefix(o.lastError, "verify: ") {
		t.Fatalf("order row %+v", o)
	}
}
