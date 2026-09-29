package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/authjwt"
)

// A refresh token (aud="auth") signed by the auth service's key is refused on
// every sync route; only an access token (aud contains "chat") is a bearer.
func TestRefreshTokenRejectedOnSyncRoutes(t *testing.T) {
	key, verifier := testKeys(t)
	r := newTestService(t, nil).router(verifier, "")

	refresh := mintToken(t, key, uuid.NewString(), false, "auth")
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/profile/sync/push"},
		{http.MethodPost, "/profile/sync/pull"},
		{http.MethodPost, "/profile/sync/cursor"},
	} {
		rec := do(t, r, route.method, route.path, refresh, map[string]any{"device_id": ""}, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with refresh token: want 401, got %d (%s)", route.method, route.path, rec.Code, rec.Body.String())
		}
	}

	both := mintToken(t, key, uuid.NewString(), false, "auth", authjwt.AudienceChat)
	if rec := do(t, r, http.MethodPost, "/profile/sync/push", both, map[string]any{"device_id": ""}, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("aud containing chat must reach the handler (400 on empty device_id), got %d", rec.Code)
	}
}
