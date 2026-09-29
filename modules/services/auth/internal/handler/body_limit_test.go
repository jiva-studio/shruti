package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/providers"
	"github.com/jiva-studio/shruti/auth/internal/service"
)

type rejectingVerifier struct{}

func (rejectingVerifier) Verify(context.Context, string) (*providers.Identity, error) {
	return nil, errors.New("rejected")
}

// TestPublicEndpointsRejectOversizedBody: every unauthenticated JSON
// endpoint answers 413 to a body over 64 KiB before it reaches the service.
func TestPublicEndpointsRejectOversizedBody(t *testing.T) {
	signer, verifier := newTokenPair(t)
	svc := &service.Service{
		Signer:         signer,
		Verifier:       verifier,
		GoogleVerifier: rejectingVerifier{},
		AppleVerifier:  rejectingVerifier{},
	}
	router := NewRouter(svc, verifier)
	pad := strings.Repeat("a", 70<<10)

	for _, tc := range []struct{ path, body string }{
		{"/auth/signin/google", `{"idToken":"x","deviceId":"` + pad + `"}`},
		{"/auth/signin/apple", `{"idToken":"x","fullName":"` + pad + `"}`},
		{"/auth/refresh", `{"refreshToken":"` + pad + `"}`},
		{"/auth/signin/email/request", `{"email":"a@example.com","locale":"` + pad + `"}`},
		{"/auth/signin/email/verify", `{"email":"a@example.com","code":"123456","deviceId":"` + pad + `"}`},
		{"/auth/anonymous", `{"deviceId":"` + pad + `"}`},
	} {
		t.Run(tc.path, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			r.RemoteAddr = "203.0.113.7:1234"
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("got %d, want 413 (body=%.200s)", w.Code, w.Body.String())
			}
		})
	}
}

// TestPublicEndpointsAcceptBodyUnderLimit: a normal-size body still
// reaches the service.
func TestPublicEndpointsAcceptBodyUnderLimit(t *testing.T) {
	signer, verifier := newTokenPair(t)
	svc := &service.Service{Signer: signer, Verifier: verifier, GoogleVerifier: rejectingVerifier{}}
	router := NewRouter(svc, verifier)
	r := httptest.NewRequest(http.MethodPost, "/auth/signin/google",
		strings.NewReader(`{"idToken":"x","deviceId":"`+strings.Repeat("a", 60<<10)+`"}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401 from the rejecting verifier", w.Code)
	}
}
