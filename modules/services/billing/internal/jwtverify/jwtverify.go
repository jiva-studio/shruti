// Package jwtverify validates the auth service's user access tokens (RS256,
// kid="v1", aud="chat"). Billing only verifies tokens — it never signs — so it
// loads just the public key. Anonymous tokens are rejected by the checkout
// handler: only signed-in users may buy.
package jwtverify

import (
	"crypto/rsa"
	"errors"
	"fmt"
	"os"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// SignerKid mirrors the auth service's single key id.
const SignerKid = "v1"

// Audience the access token must carry.
const AudienceChat = "chat"

type Claims struct {
	Anonymous bool `json:"anonymous"`
	gjwt.RegisteredClaims
}

func (c *Claims) UserID() (uuid.UUID, error) {
	return uuid.Parse(c.Subject)
}

type Verifier struct {
	key *rsa.PublicKey
}

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

// Verify checks signature + exp + alg + kid + audience. Returns claims if valid.
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
	},
		gjwt.WithValidMethods([]string{"RS256"}),
		gjwt.WithAudience(AudienceChat),
	)
	if err != nil {
		return nil, err
	}
	if claims.Subject == "" {
		return nil, errors.New("missing sub")
	}
	return claims, nil
}
