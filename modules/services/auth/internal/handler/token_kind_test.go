package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/service"
)

func newTokenPair(t *testing.T) (*jwt.Signer, *jwt.Verifier) {
	t.Helper()
	priv, pub := tempKeys(t)
	signer, err := jwt.NewSignerFromFile(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	verifier, err := jwt.NewVerifierFromFile(pub)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return signer, verifier
}

func issue(t *testing.T, s *jwt.Signer, aud string) string {
	t.Helper()
	tok, _, err := s.Issue(jwt.IssueInput{UserID: uuid.New(), Audience: aud, TTL: time.Hour})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return tok
}

// TestBearerRoutesRejectRefreshToken: a refresh token (aud=auth) is not a
// Bearer credential. The middleware rejects it before any handler or DB
// call, so the Service here has no pool.
func TestBearerRoutesRejectRefreshToken(t *testing.T) {
	signer, verifier := newTokenPair(t)
	router := NewRouter(&service.Service{Signer: signer, Verifier: verifier}, verifier)
	refresh := issue(t, signer, jwt.AudienceAuth)

	for _, rt := range []struct{ method, path string }{
		{http.MethodGet, "/auth/me"},
		{http.MethodPost, "/auth/account/delete"},
		{http.MethodPost, "/auth/signout"},
	} {
		t.Run(rt.path, func(t *testing.T) {
			r := httptest.NewRequest(rt.method, rt.path, bytes.NewBufferString(`{}`))
			r.Header.Set("Authorization", "Bearer "+refresh)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("refresh token as Bearer on %s: got %d, want 401 (body=%s)", rt.path, w.Code, w.Body.String())
			}
		})
	}
}

// TestRefreshRouteRejectsAccessToken: an access token (aud=chat) sent to
// /auth/refresh is rejected as a token problem (401) without touching the
// refresh_tokens table.
func TestRefreshRouteRejectsAccessToken(t *testing.T) {
	signer, verifier := newTokenPair(t)
	router := NewRouter(&service.Service{Signer: signer, Verifier: verifier}, verifier)
	access := issue(t, signer, jwt.AudienceChat)

	r := httptest.NewRequest(http.MethodPost, "/auth/refresh",
		bytes.NewBufferString(`{"refreshToken":"`+access+`"}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("access token on /auth/refresh: got %d, want 401 (body=%s)", w.Code, w.Body.String())
	}
}

// TestRevokedRefreshTokenIsNotABearer: after signout revokes a refresh
// token, that token still has a valid signature for 90 days. It must not
// authenticate /auth/me or /auth/account/delete, while the session's access
// token keeps working.
func TestRevokedRefreshTokenIsNotABearer(t *testing.T) {
	_, svc, _ := bootWebhook(t)
	ctx := t.Context()
	router := NewRouter(svc, svc.Verifier)

	sess, err := svc.Anonymous(ctx, "device-revoked-refresh", "")
	if err != nil {
		t.Fatalf("anonymous: %v", err)
	}
	if err := svc.Signout(ctx, sess.RefreshToken); err != nil {
		t.Fatalf("signout: %v", err)
	}

	call := func(method, path, bearer string) int {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Authorization", "Bearer "+bearer)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code
	}
	if got := call(http.MethodGet, "/auth/me", sess.RefreshToken); got != http.StatusUnauthorized {
		t.Fatalf("revoked refresh on /auth/me: got %d, want 401", got)
	}
	if got := call(http.MethodPost, "/auth/account/delete", sess.RefreshToken); got != http.StatusUnauthorized {
		t.Fatalf("revoked refresh on /auth/account/delete: got %d, want 401", got)
	}
	if got := call(http.MethodGet, "/auth/me", sess.AccessToken); got != http.StatusOK {
		t.Fatalf("access token on /auth/me: got %d, want 200", got)
	}
	u, err := svc.Users.Get(ctx, sess.UserID)
	if err != nil || u == nil {
		t.Fatalf("user must survive a rejected delete: u=%v err=%v", u, err)
	}
}
