// Package jwt verifies the shared RS256 access tokens (kid="v1") that the
// mobile and web clients present. profile is verify-only — it never mints
// tokens. It accepts the existing aud="chat" access token per the design
// doc, so no auth-service change is needed to ship.
package jwt

import (
	"crypto/rsa"
	"errors"
	"fmt"
	"os"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// SignerKid is the single key id every accepted token must carry. Mirrors
// the auth service; tokens without a kid, or with a foreign kid, are rejected.
const SignerKid = "v1"

// AudienceChat is the audience the mobile and web clients already hold and
// that profile accepts (the design doc's "simplest path": reuse the chat
// access token, optionally widening aud to include "profile" later).
const AudienceChat = "chat"

// Claims is the subset of the auth-issued payload profile cares about: the
// subject (user id) and the standard registered claims (aud/exp/iat/sub). The
// `anonymous` flag is decoded but not gated on — the sync substrate is
// identity-agnostic and serves anonymous and signed-in tokens alike.
type Claims struct {
	Anonymous bool `json:"anonymous"`
	gjwt.RegisteredClaims
}

// Verifier checks signature/exp/kid of tokens issued by the auth service.
type Verifier struct {
	key *rsa.PublicKey
}

// NewVerifierFromFile reads a single PEM-encoded RSA public key.
func NewVerifierFromFile(path string) (*Verifier, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read public key %s: %w", path, err)
	}
	pub, err := gjwt.ParseRSAPublicKeyFromPEM(b)
	if err != nil {
		return nil, fmt.Errorf("parse public key %s: %w", path, err)
	}
	return &Verifier{key: pub}, nil
}

// Verify parses and checks signature + exp + kid. Returns claims if valid.
// The kid header is required and must equal SignerKid ("v1").
func (v *Verifier) Verify(token string) (*Claims, error) {
	claims := &Claims{}
	_, err := gjwt.ParseWithClaims(token, claims, func(t *gjwt.Token) (any, error) {
		if _, ok := t.Method.(*gjwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected alg %v", t.Header["alg"])
		}
		kid, _ := t.Header["kid"].(string)
		if kid != SignerKid {
			return nil, fmt.Errorf("unexpected kid %q (want %q)", kid, SignerKid)
		}
		return v.key, nil
	}, gjwt.WithValidMethods([]string{"RS256"}))
	if err != nil {
		return nil, err
	}
	return claims, nil
}

// UserID extracts the sub from verified Claims as a UUID.
func (c *Claims) UserID() (uuid.UUID, error) {
	if c.Subject == "" {
		return uuid.Nil, errors.New("missing sub")
	}
	return uuid.Parse(c.Subject)
}

// HasAudience reports whether the token's aud contains the wanted value.
func (c *Claims) HasAudience(want string) bool {
	for _, a := range c.Audience {
		if a == want {
			return true
		}
	}
	return false
}
