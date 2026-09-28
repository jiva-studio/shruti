package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/providers"
)

// The contract tests below pin what installed clients rely on: for every
// /auth/* route, the status code and the exact set of JSON keys (and the
// error code) of each answer. They run over HTTP through the router only.

// capturingMailer keeps the last message sent to each address.
type capturingMailer struct {
	mu   sync.Mutex
	text map[string]string
}

func (m *capturingMailer) Send(_ context.Context, to, _, text, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.text == nil {
		m.text = map[string]string{}
	}
	m.text[to] = text
	return nil
}

var sixDigits = regexp.MustCompile(`\b\d{6}\b`)

func (m *capturingMailer) codeFor(t *testing.T, to string) string {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	code := sixDigits.FindString(m.text[to])
	if code == "" {
		t.Fatalf("no code mailed to %s", to)
	}
	return code
}

// fixedIdentity answers every id token with the same provider identity;
// the id token "reject" is refused.
type fixedIdentity struct{ ident providers.Identity }

func (f fixedIdentity) Verify(_ context.Context, idToken string) (*providers.Identity, error) {
	if idToken == "reject" {
		return nil, errors.New("id token rejected")
	}
	id := f.ident
	return &id, nil
}

type contractEnv struct {
	router http.Handler
	mail   *capturingMailer
}

func call(t *testing.T, h http.Handler, method, path, bearer, body string) (int, map[string]any, http.Header) {
	t.Helper()
	var rd *bytes.Reader
	if body == "" {
		rd = bytes.NewReader(nil)
	} else {
		rd = bytes.NewReader([]byte(body))
	}
	r := httptest.NewRequest(method, path, rd)
	r.RemoteAddr = "203.0.113.9:4000"
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var out map[string]any
	if w.Body.Len() > 0 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s %s: body is not a JSON object: %q", method, path, w.Body.String())
		}
	}
	return w.Code, out, w.Header()
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func wantKeys(t *testing.T, what string, m map[string]any, want ...string) {
	t.Helper()
	sort.Strings(want)
	if got := keysOf(m); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("%s keys = %v, want %v", what, got, want)
	}
}

func wantError(t *testing.T, what string, status int, body map[string]any, wantStatus int, wantCode string) {
	t.Helper()
	if status != wantStatus {
		t.Fatalf("%s: status %d, want %d (body %v)", what, status, wantStatus, body)
	}
	wantKeys(t, what, body, "error")
	e, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("%s: error is %T", what, body["error"])
	}
	wantKeys(t, what+" error", e, "code", "message")
	if e["code"] != wantCode {
		t.Fatalf("%s: code %v, want %s", what, e["code"], wantCode)
	}
}

func wantSession(t *testing.T, what string, status int, body map[string]any, anonymous bool) (access, refresh string) {
	t.Helper()
	if status != http.StatusOK {
		t.Fatalf("%s: status %d, want 200 (body %v)", what, status, body)
	}
	wantKeys(t, what, body, "accessToken", "refreshToken", "userId", "anonymous")
	if body["anonymous"] != anonymous {
		t.Fatalf("%s: anonymous %v, want %v", what, body["anonymous"], anonymous)
	}
	access, _ = body["accessToken"].(string)
	refresh, _ = body["refreshToken"].(string)
	if access == "" || refresh == "" {
		t.Fatalf("%s: empty token in %v", what, body)
	}
	return access, refresh
}

func TestContractHealthzAndMetrics(t *testing.T) {
	env := newContractEnv(t)
	status, body, _ := call(t, env.router, http.MethodGet, "/auth/healthz", "", "")
	if status != http.StatusOK {
		t.Fatalf("healthz status %d", status)
	}
	wantKeys(t, "healthz", body, "status", "build")
	if body["status"] != "ok" {
		t.Fatalf("healthz status field %v", body["status"])
	}
	build, _ := body["build"].(map[string]any)
	wantKeys(t, "healthz build", build, "sha", "time")

	r := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	w := httptest.NewRecorder()
	env.router.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("metrics status %d", w.Code)
	}
}

func TestContractAnonymous(t *testing.T) {
	env := newContractEnv(t)
	status, body, _ := call(t, env.router, http.MethodPost, "/auth/anonymous", "", `{"platform":"ios"}`)
	wantError(t, "no deviceId", status, body, http.StatusBadRequest, "missing_device_id")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/anonymous", "", `not json`)
	wantError(t, "bad json", status, body, http.StatusBadRequest, "bad_request")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/anonymous", "", `{"deviceId":"dev-contract","platform":"ios"}`)
	_, _ = wantSession(t, "anonymous", status, body, true)
	first := body["userId"]

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/anonymous", "", `{"deviceId":"dev-contract"}`)
	_, _ = wantSession(t, "anonymous again", status, body, true)
	if body["userId"] != first {
		t.Fatalf("same device got a different user: %v then %v", first, body["userId"])
	}
}

func TestContractSocialSignin(t *testing.T) {
	env := newContractEnv(t)
	for _, path := range []string{"/auth/signin/google", "/auth/signin/apple"} {
		t.Run(path, func(t *testing.T) {
			status, body, _ := call(t, env.router, http.MethodPost, path, "", `{}`)
			wantError(t, "no idToken", status, body, http.StatusBadRequest, "missing_id_token")

			status, body, _ = call(t, env.router, http.MethodPost, path, "", `{"idToken":"reject"}`)
			wantError(t, "rejected", status, body, http.StatusUnauthorized, "signin_failed")

			status, body, _ = call(t, env.router, http.MethodPost, path, "", `{"idToken":"good","deviceId":"d1","fullName":"Ada"}`)
			_, _ = wantSession(t, "signin", status, body, false)
		})
	}
}

func TestContractAnonymousUpgradeOnSignin(t *testing.T) {
	env := newContractEnv(t)
	status, body, _ := call(t, env.router, http.MethodPost, "/auth/anonymous", "", `{"deviceId":"dev-upgrade"}`)
	anonAccess, _ := wantSession(t, "anonymous", status, body, true)
	anonUser := body["userId"]

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signin/google", anonAccess, `{"idToken":"good"}`)
	_, _ = wantSession(t, "upgrade", status, body, false)
	if body["userId"] != anonUser {
		t.Fatalf("upgrade moved the user: %v → %v", anonUser, body["userId"])
	}
}

func TestContractRefreshAndSignout(t *testing.T) {
	env := newContractEnv(t)
	status, body, _ := call(t, env.router, http.MethodPost, "/auth/refresh", "", `{}`)
	wantError(t, "no refreshToken", status, body, http.StatusBadRequest, "missing_refresh")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/refresh", "", `{"refreshToken":"garbage"}`)
	wantError(t, "garbage", status, body, http.StatusUnauthorized, "refresh_failed")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/anonymous", "", `{"deviceId":"dev-refresh"}`)
	access, refresh := wantSession(t, "anonymous", status, body, true)

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/refresh", "", `{"refreshToken":"`+refresh+`"}`)
	_, rotated := wantSession(t, "refresh", status, body, true)

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signout", "", `{"refreshToken":"`+rotated+`"}`)
	wantError(t, "signout without bearer", status, body, http.StatusUnauthorized, "missing_token")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signout", access, `{"refreshToken":"`+rotated+`"}`)
	if status != http.StatusOK {
		t.Fatalf("signout status %d (%v)", status, body)
	}
	wantKeys(t, "signout", body)

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/refresh", "", `{"refreshToken":"`+rotated+`"}`)
	wantError(t, "refresh after signout", status, body, http.StatusUnauthorized, "refresh_failed")
}

func TestContractMeAndDelete(t *testing.T) {
	env := newContractEnv(t)
	status, body, _ := call(t, env.router, http.MethodGet, "/auth/me", "", "")
	wantError(t, "me without bearer", status, body, http.StatusUnauthorized, "missing_token")

	status, body, _ = call(t, env.router, http.MethodGet, "/auth/me", "not-a-token", "")
	wantError(t, "me with junk", status, body, http.StatusUnauthorized, "invalid_token")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signin/google", "", `{"idToken":"good"}`)
	access, _ := wantSession(t, "signin", status, body, false)

	status, body, _ = call(t, env.router, http.MethodGet, "/auth/me", access, "")
	if status != http.StatusOK {
		t.Fatalf("me status %d (%v)", status, body)
	}
	wantKeys(t, "me", body, "userId", "anonymous", "createdAt", "tier", "email", "name", "pictureUrl", "identities")
	if body["tier"] != "free" || body["anonymous"] != false || body["email"] != "ada@example.com" || body["name"] != "Ada" {
		t.Fatalf("me = %v", body)
	}
	idents, _ := body["identities"].([]any)
	if len(idents) != 1 {
		t.Fatalf("me identities = %v", body["identities"])
	}
	ident, _ := idents[0].(map[string]any)
	wantKeys(t, "me identity", ident, "provider", "subject", "email", "emailVerified", "createdAt")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/account/delete", access, "")
	if status != http.StatusOK {
		t.Fatalf("delete status %d (%v)", status, body)
	}
	wantKeys(t, "delete", body)

	status, body, hdr := call(t, env.router, http.MethodPost, "/auth/account/delete", access, "")
	wantError(t, "second delete", status, body, http.StatusTooManyRequests, "rate_limited")
	if hdr.Get("Retry-After") == "" {
		t.Fatal("second delete has no Retry-After")
	}
}

func TestContractEmailOTP(t *testing.T) {
	env := newContractEnv(t)
	status, body, _ := call(t, env.router, http.MethodPost, "/auth/signin/email/request", "", `{"email":"not an email"}`)
	wantError(t, "invalid email", status, body, http.StatusBadRequest, "invalid_email")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signin/email/request", "", `{"email":"Reader@Example.com","locale":"ru"}`)
	if status != http.StatusOK {
		t.Fatalf("request status %d (%v)", status, body)
	}
	wantKeys(t, "request", body)

	status, body, hdr := call(t, env.router, http.MethodPost, "/auth/signin/email/request", "", `{"email":"reader@example.com"}`)
	wantError(t, "resend", status, body, http.StatusTooManyRequests, "otp_throttled")
	if hdr.Get("Retry-After") != "60" {
		t.Fatalf("resend Retry-After = %q", hdr.Get("Retry-After"))
	}

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signin/email/verify", "", `{"email":"reader@example.com"}`)
	wantError(t, "no code", status, body, http.StatusBadRequest, "missing_code")

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signin/email/verify", "", `{"email":"reader@example.com","code":"000000x"}`)
	wantError(t, "wrong code", status, body, http.StatusUnauthorized, "otp_invalid")

	code := env.mail.codeFor(t, "reader@example.com")
	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signin/email/verify", "", `{"email":"reader@example.com","code":"`+code+`","deviceId":"d9"}`)
	_, _ = wantSession(t, "verify", status, body, false)

	status, body, _ = call(t, env.router, http.MethodPost, "/auth/signin/email/verify", "", `{"email":"reader@example.com","code":"`+code+`"}`)
	wantError(t, "code reused", status, body, http.StatusUnauthorized, "otp_invalid")
}

func TestContractEmailOTPDisabled(t *testing.T) {
	env := newContractEnvWithoutMail(t)
	status, body, _ := call(t, env.router, http.MethodPost, "/auth/signin/email/request", "", `{"email":"reader@example.com"}`)
	wantError(t, "request", status, body, http.StatusServiceUnavailable, "email_disabled")
}
