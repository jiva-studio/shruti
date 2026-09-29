package handler

import (
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/authjwt"
)

// The tests in this file pin what every route answers — status and the exact
// JSON body — through the router alone. Only the two setup helpers know how
// the router is wired.

// noDBRouter wires every route with no database behind it: whatever it answers
// is decided before a query runs.
func noDBRouter(t *testing.T, purgeToken string) (http.Handler, *rsa.PrivateKey) {
	t.Helper()
	key, verifier := testKeys(t)
	svc := newTestService(t, nil)
	return svc.router(verifier, purgeToken), key
}

// dbRouter wires every route over a freshly migrated schema.
func dbRouter(t *testing.T, purgeToken string) (http.Handler, *rsa.PrivateKey, *pgxpool.Pool) {
	t.Helper()
	svc := freshDBService(t)
	key, verifier := testKeys(t)
	return svc.router(verifier, purgeToken), key, svc.Pool
}

func decodeJSON(t *testing.T, body string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return v
}

func assertJSON(t *testing.T, gotBody, wantBody string) {
	t.Helper()
	got, want := decodeJSON(t, gotBody), decodeJSON(t, wantBody)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("body\n got  %s\n want %s", strings.TrimSpace(gotBody), wantBody)
	}
}

func errBody(code, msg string) string {
	b, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": msg}})
	return string(b)
}

func TestHealthzShape(t *testing.T) {
	h, _ := noDBRouter(t, "")
	rec := do(t, h, http.MethodGet, "/healthz", "", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	assertJSON(t, rec.Body.String(), `{"status":"ok","build":{"sha":"`+buildSHA+`","time":"`+buildTime+`"}}`)
}

func TestReadyzWithoutDatabase(t *testing.T) {
	h, _ := noDBRouter(t, "")
	rec := do(t, h, http.MethodGet, "/readyz", "", nil, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", rec.Code)
	}
	assertJSON(t, rec.Body.String(), errBody("not_ready", "no db pool"))
}

func TestReadyzOnCurrentSchema(t *testing.T) {
	h, _, _ := dbRouter(t, "")
	rec := do(t, h, http.MethodGet, "/readyz", "", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	assertJSON(t, rec.Body.String(), `{"status":"ready"}`)
}

func TestSyncRoutesRefuseMissingAndInvalidTokens(t *testing.T) {
	h, key := noDBRouter(t, "")
	expired := func() string {
		tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, authjwt.Claims{
			RegisteredClaims: gjwt.RegisteredClaims{
				Subject:   uuid.NewString(),
				Audience:  gjwt.ClaimStrings{authjwt.AudienceChat},
				ExpiresAt: gjwt.NewNumericDate(time.Now().Add(-time.Minute)),
			},
		})
		tok.Header["kid"] = authjwt.Kid
		s, err := tok.SignedString(key)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return s
	}()
	for _, path := range []string{"/profile/sync/push", "/profile/sync/pull", "/profile/sync/cursor"} {
		t.Run(path, func(t *testing.T) {
			rec := do(t, h, http.MethodPost, path, "", map[string]any{}, nil)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("no token: status %d, want 401", rec.Code)
			}
			assertJSON(t, rec.Body.String(), errBody("missing_token", "Authorization header required"))

			for name, tok := range map[string]string{"garbage": "not-a-jwt", "expired": expired} {
				rec := do(t, h, http.MethodPost, path, tok, map[string]any{}, nil)
				if rec.Code != http.StatusUnauthorized {
					t.Fatalf("%s token: status %d, want 401", name, rec.Code)
				}
				body := decodeJSON(t, rec.Body.String()).(map[string]any)
				if code := body["error"].(map[string]any)["code"]; code != "invalid_token" {
					t.Fatalf("%s token: code %v, want invalid_token", name, code)
				}
			}
		})
	}
}

func TestPushValidationErrors(t *testing.T) {
	h, key := noDBRouter(t, "")
	tok := mintToken(t, key, uuid.NewString(), false, authjwt.AudienceChat)
	change := func(over map[string]any) map[string]any {
		c := map[string]any{"collection": "notes", "doc_id": "n1", "op": "upsert", "hlc": "h1", "data": map[string]any{}}
		for k, v := range over {
			c[k] = v
		}
		return c
	}
	for _, tc := range []struct {
		name string
		body any
		msg  string
	}{
		{"no device", map[string]any{"device_id": ""}, "device_id is required"},
		{"unknown collection", map[string]any{"device_id": "d", "changes": []any{change(map[string]any{"collection": "nope"})}}, `unknown collection "nope"`},
		{"bad op", map[string]any{"device_id": "d", "changes": []any{change(map[string]any{"op": "patch"})}}, `invalid op "patch" (want upsert|delete)`},
		{"no doc id", map[string]any{"device_id": "d", "changes": []any{change(map[string]any{"doc_id": ""})}}, "doc_id is required"},
		{"no hlc", map[string]any{"device_id": "d", "changes": []any{change(map[string]any{"hlc": ""})}}, "hlc is required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(t, h, http.MethodPost, "/profile/sync/push", tok, tc.body, nil)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400 (%s)", rec.Code, rec.Body.String())
			}
			assertJSON(t, rec.Body.String(), errBody("bad_request", tc.msg))
		})
	}
}

func TestSyncRoutesRejectMalformedJSON(t *testing.T) {
	h, key := noDBRouter(t, "")
	tok := mintToken(t, key, uuid.NewString(), false, authjwt.AudienceChat)
	for _, path := range []string{"/profile/sync/push", "/profile/sync/pull", "/profile/sync/cursor"} {
		rec := do(t, h, http.MethodPost, path, tok, "not an object", nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d, want 400", path, rec.Code)
		}
		assertJSON(t, rec.Body.String(), errBody("bad_request", "malformed json"))
	}
}

func TestCursorRequiresDevice(t *testing.T) {
	h, key := noDBRouter(t, "")
	tok := mintToken(t, key, uuid.NewString(), false, authjwt.AudienceChat)
	rec := do(t, h, http.MethodPost, "/profile/sync/cursor", tok, map[string]any{"acked_seq": 3}, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	assertJSON(t, rec.Body.String(), errBody("bad_request", "device_id is required"))
}

func TestPushPullCursorShapes(t *testing.T) {
	h, key, _ := dbRouter(t, "")
	tok := mintToken(t, key, uuid.NewString(), false, authjwt.AudienceChat)

	rec := do(t, h, http.MethodPost, "/profile/sync/pull", tok, map[string]any{"cursor": 0, "limit": 10}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty pull: status %d", rec.Code)
	}
	assertJSON(t, rec.Body.String(), `{"changes":[],"cursor":0,"has_more":false}`)

	rec = do(t, h, http.MethodPost, "/profile/sync/push", tok, map[string]any{
		"device_id": "devA",
		"changes": []any{map[string]any{
			"collection": "notes", "doc_id": "n1", "op": "upsert", "hlc": "h1", "data": map[string]any{"text": "a"},
		}},
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("push: status %d (%s)", rec.Code, rec.Body.String())
	}
	assertJSON(t, rec.Body.String(), `{"applied":[{"collection":"notes","doc_id":"n1"}],"conflicts":[]}`)

	// A stale base comes back as a conflict carrying the master row.
	rec = do(t, h, http.MethodPost, "/profile/sync/push", tok, map[string]any{
		"device_id": "devB",
		"changes": []any{map[string]any{
			"collection": "notes", "doc_id": "n1", "op": "delete", "hlc": "h2", "base_hlc": "h0",
		}},
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("conflicting push: status %d (%s)", rec.Code, rec.Body.String())
	}
	assertJSON(t, rec.Body.String(), `{"applied":[],"conflicts":[{"collection":"notes","doc_id":"n1",`+
		`"master":{"server_seq":1,"collection":"notes","doc_id":"n1","op":"upsert","data":{"text":"a"},"hlc":"h1"}}]}`)

	// A delete ships no data.
	rec = do(t, h, http.MethodPost, "/profile/sync/push", tok, map[string]any{
		"device_id": "devB",
		"changes": []any{map[string]any{
			"collection": "notes", "doc_id": "n1", "op": "delete", "hlc": "h2", "base_hlc": "h1",
		}},
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete push: status %d (%s)", rec.Code, rec.Body.String())
	}

	rec = do(t, h, http.MethodPost, "/profile/sync/pull", tok, map[string]any{"cursor": 0, "limit": 1}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("pull page 1: status %d", rec.Code)
	}
	assertJSON(t, rec.Body.String(), `{"changes":[{"server_seq":1,"collection":"notes","doc_id":"n1","op":"upsert","data":{"text":"a"},"hlc":"h1"}],"cursor":1,"has_more":true}`)

	rec = do(t, h, http.MethodPost, "/profile/sync/pull", tok, map[string]any{"cursor": 1, "limit": 10}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("pull page 2: status %d", rec.Code)
	}
	assertJSON(t, rec.Body.String(), `{"changes":[{"server_seq":2,"collection":"notes","doc_id":"n1","op":"delete","hlc":"h2"}],"cursor":2,"has_more":false}`)

	rec = do(t, h, http.MethodPost, "/profile/sync/cursor", tok, map[string]any{"device_id": "devA", "acked_seq": 2}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("cursor: status %d", rec.Code)
	}
	assertJSON(t, rec.Body.String(), `{"ok":true}`)
}

func TestInternalPurgeResponses(t *testing.T) {
	closed, _ := noDBRouter(t, "")
	rec := do(t, closed, http.MethodPost, "/internal/purge", "", map[string]any{"user_id": uuid.NewString()}, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no token configured: status %d, want 503", rec.Code)
	}
	assertJSON(t, rec.Body.String(), errBody("not_configured", "this endpoint requires INTERNAL_API_TOKEN"))

	h, _ := noDBRouter(t, "s3cret")
	auth := map[string]string{"X-Internal-Token": "s3cret"}
	for _, tc := range []struct {
		name    string
		body    any
		headers map[string]string
		status  int
		want    string
	}{
		{"missing token", map[string]any{"user_id": uuid.NewString()}, nil, http.StatusUnauthorized, errBody("unauthorized", "bad internal token")},
		{"malformed json", "nope", auth, http.StatusBadRequest, errBody("bad_request", "malformed json")},
		{"bad uuid", map[string]any{"user_id": "x"}, auth, http.StatusBadRequest, errBody("bad_request", "user_id must be a uuid")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(t, h, http.MethodPost, "/internal/purge", "", tc.body, tc.headers)
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d", rec.Code, tc.status)
			}
			assertJSON(t, rec.Body.String(), tc.want)
		})
	}
}

func TestInternalPurgeOKShape(t *testing.T) {
	h, _, _ := dbRouter(t, "s3cret")
	rec := do(t, h, http.MethodPost, "/internal/purge", "", map[string]any{"user_id": uuid.NewString()},
		map[string]string{"X-Internal-Token": "s3cret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	assertJSON(t, rec.Body.String(), `{"ok":true}`)
}
