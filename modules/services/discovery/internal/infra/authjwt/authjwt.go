// Package authjwt verifies the shared RS256 access tokens (kid="v1") the
// mobile client presents. Discovery is verify-only — it never mints one — and
// it reads nothing out of the token beyond the subject: searching the index is
// not tier-gated, and what a person may then DO with a recording is decided by
// the orchestrator when they ask for it.
//
// The same key file the orchestrator reads, for the same reason: one signer,
// one public half, one name for it across the deployment.
package authjwt

import (
	"crypto/rsa"
	"fmt"
	"os"

	gjwt "github.com/golang-jwt/jwt/v5"
)

// signerKid mirrors the auth service: every accepted token carries kid="v1".
const signerKid = "v1"

// Verifier checks signature, expiry and kid.
type Verifier struct {
	key *rsa.PublicKey
}

// NewFromFile reads a single PEM-encoded RSA public key.
func NewFromFile(path string) (*Verifier, error) {
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

// Verify parses and validates the token and returns its subject.
func (v *Verifier) Verify(token string) (string, error) {
	c := &gjwt.RegisteredClaims{}
	if _, err := gjwt.ParseWithClaims(token, c, func(t *gjwt.Token) (any, error) {
		if _, ok := t.Method.(*gjwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected alg %v", t.Header["alg"])
		}
		if kid, _ := t.Header["kid"].(string); kid != signerKid {
			return nil, fmt.Errorf("unexpected kid %q (want %q)", kid, signerKid)
		}
		return v.key, nil
	}, gjwt.WithValidMethods([]string{"RS256"})); err != nil {
		return "", err
	}
	return c.Subject, nil
}
