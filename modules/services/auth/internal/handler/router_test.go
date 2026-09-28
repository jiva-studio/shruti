package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/service"
	"github.com/jiva-studio/shruti/authjwt"
)

// TestRouter_DeletedRoutesReturn404: the cross-region migration / lookup /
// RC fanout paths are not routed. A client that still has one of these
// URLs cached must get a clean 404 from chi instead of being silently
// routed to whatever the next matching handler does.
func TestRouter_DeletedRoutesReturn404(t *testing.T) {
	priv, pub := tempKeys(t)
	signer, err := authjwt.NewSignerFromFile(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	verifier, err := authjwt.NewVerifierFromFile(pub)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	svc := &service.Service{Signer: signer, Verifier: verifier}
	router := NewRouter(svc, verifier)

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/auth/migrate-in"},
		{http.MethodPost, "/auth/migrate-revoke"},
		{http.MethodPost, "/auth/lookup"},
		{http.MethodPost, "/internal/subscription/apply"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != http.StatusNotFound {
				t.Errorf("status: want 404, got %d (body=%s)", w.Code, w.Body.String())
			}
		})
	}
}
