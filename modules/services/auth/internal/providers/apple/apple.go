// Package apple verifies Apple Sign-In id-tokens.
//
// Apple doesn't ship a Go SDK. We fetch the public JWKS from
// https://appleid.apple.com/auth/keys, cache it for 10 min, validate the
// JWT signature (RS256), and check iss/aud/exp manually.
package apple

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"

	"github.com/akdasa-studios/shruti/auth/internal/providers"
)

const (
	appleIssuer  = "https://appleid.apple.com"
	jwksURL      = "https://appleid.apple.com/auth/keys"
	jwksCacheTTL = 10 * time.Minute
)

// Verifier validates Apple id-tokens against the configured bundle IDs.
type Verifier struct {
	allowedBundleIDs []string
	httpClient       *http.Client

	mu        sync.RWMutex
	jwks      gjwt.Keyfunc
	jwksAt    time.Time
	rawCached *cachedKeys

	// JWKSURLOverride lets tests point at a fake JWKS endpoint.
	JWKSURLOverride string
}

func NewVerifier(bundleIDs []string) *Verifier {
	return &Verifier{
		allowedBundleIDs: bundleIDs,
		httpClient:       &http.Client{Timeout: 5 * time.Second},
	}
}

// Verify validates the id-token and returns the normalized identity.
func (v *Verifier) Verify(ctx context.Context, idToken string) (*providers.Identity, error) {
	if len(v.allowedBundleIDs) == 0 {
		return nil, errors.New("no apple bundle IDs configured")
	}

	keyfunc, err := v.keyfunc(ctx)
	if err != nil {
		return nil, fmt.Errorf("apple: jwks fetch: %w", err)
	}

	claims := gjwt.MapClaims{}
	if _, err := gjwt.ParseWithClaims(idToken, claims, keyfunc,
		gjwt.WithValidMethods([]string{"RS256"}),
		gjwt.WithIssuer(appleIssuer),
	); err != nil {
		return nil, fmt.Errorf("apple: id-token invalid: %w", err)
	}

	// Audience check: Apple's `aud` is a single string (the bundle / service ID).
	aud, _ := claims["aud"].(string)
	if !slices.Contains(v.allowedBundleIDs, aud) {
		return nil, fmt.Errorf("apple: aud %q not allowed", aud)
	}

	sub, _ := claims["sub"].(string)
	if sub == "" {
		return nil, errors.New("apple: missing sub")
	}

	id := &providers.Identity{Subject: sub}
	if email, ok := claims["email"].(string); ok {
		id.Email = email
	}
	// Apple emits email_verified as either bool or string ("true"). Be lenient.
	switch t := claims["email_verified"].(type) {
	case bool:
		id.EmailVerified = t
	case string:
		id.EmailVerified = t == "true"
	}

	// is_private_email indicates a relay email; we still treat it as verified
	// (Apple guarantees deliverability), but the consumer can decide whether
	// to surface it as user-displayable.
	return id, nil
}
