// Package google verifies Google OIDC id-tokens.
//
// Uses google.golang.org/api/idtoken which fetches + caches Google's JWKS
// internally and validates signature, exp, iss="accounts.google.com" or
// "https://accounts.google.com".
package google

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"google.golang.org/api/idtoken"

	"github.com/akdasa-studios/shruti/auth/internal/providers"
)

// Verifier checks Google id-tokens against a fixed allow-list of client IDs.
type Verifier struct {
	allowedClientIDs []string
}

func NewVerifier(clientIDs []string) *Verifier {
	return &Verifier{allowedClientIDs: clientIDs}
}

// Verify validates the id-token and returns the normalized identity.
//
// idtoken.Validate accepts an audience parameter; we pass "" to skip its
// audience check and validate `aud` ourselves so we can accept any of the
// configured client IDs (Android + iOS + Web all share one user).
func (v *Verifier) Verify(ctx context.Context, idToken string) (*providers.Identity, error) {
	if len(v.allowedClientIDs) == 0 {
		return nil, errors.New("no google client IDs configured")
	}

	payload, err := idtoken.Validate(ctx, idToken, "")
	if err != nil {
		return nil, fmt.Errorf("google: id-token invalid: %w", err)
	}

	if !slices.Contains(v.allowedClientIDs, payload.Audience) {
		return nil, fmt.Errorf("google: aud %q not in allowed client IDs", payload.Audience)
	}

	sub := payload.Subject
	if sub == "" {
		return nil, errors.New("google: missing sub in id-token")
	}

	id := &providers.Identity{Subject: sub}
	if email, ok := payload.Claims["email"].(string); ok {
		id.Email = email
	}
	if name, ok := payload.Claims["name"].(string); ok {
		id.Name = name
	}
	if picture, ok := payload.Claims["picture"].(string); ok {
		id.PictureURL = picture
	}
	// `email_verified` is a JSON bool. Be lenient about type (Google sends bool,
	// some other IdPs send "true" string).
	switch v := payload.Claims["email_verified"].(type) {
	case bool:
		id.EmailVerified = v
	case string:
		id.EmailVerified = v == "true"
	}
	return id, nil
}
