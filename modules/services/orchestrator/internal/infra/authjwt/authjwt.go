// Package authjwt verifies the shared RS256 access tokens (kid="v1", aud="chat")
// the mobile/web clients present, and reads the PRO entitlement carried in the
// `tier` / `tier_expires_at` claims. The orchestrator is verify-only — it never
// mints tokens — and re-checks the entitlement at ingest time so a lapsed Pro
// tier can't ride a stale enqueued request through the pipeline.
package authjwt

import (
	"crypto/rsa"
	"fmt"
	"os"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
)

// signerKid mirrors the auth service: every accepted token carries kid="v1".
const signerKid = "v1"

// accessAudience is the `aud` on ACCESS tokens; refresh tokens carry "auth".
const accessAudience = "chat"

// claims is the subset the orchestrator reads. tier is "free" | "pro";
// tier_expires_at is UNIX-epoch seconds (0 = lifetime/free).
type claims struct {
	Tier          string `json:"tier"`
	TierExpiresAt int64  `json:"tier_expires_at"`
	gjwt.RegisteredClaims
}

// Verifier checks signature/exp/kid and evaluates the PRO entitlement.
type Verifier struct {
	key *rsa.PublicKey
	now func() time.Time
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
	return &Verifier{key: pub, now: time.Now}, nil
}

// VerifyPro parses and validates the token, then reports the subject and whether
// it grants an ACTIVE pro tier. A "pro" claim whose tier_expires_at is in the
// past is downgraded to false (a missed EXPIRATION webhook can't extend Pro).
func (v *Verifier) VerifyPro(token string) (string, bool, error) {
	c := &claims{}
	_, err := gjwt.ParseWithClaims(token, c, func(t *gjwt.Token) (any, error) {
		if _, ok := t.Method.(*gjwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected alg %v", t.Header["alg"])
		}
		if kid, _ := t.Header["kid"].(string); kid != signerKid {
			return nil, fmt.Errorf("unexpected kid %q (want %q)", kid, signerKid)
		}
		return v.key, nil
	}, gjwt.WithValidMethods([]string{"RS256"}), gjwt.WithAudience(accessAudience))
	if err != nil {
		return "", false, err
	}
	if c.Subject == "" {
		return "", false, fmt.Errorf("token has no subject")
	}
	pro := c.Tier == "pro" &&
		(c.TierExpiresAt == 0 || time.Unix(c.TierExpiresAt, 0).After(v.now()))
	return c.Subject, pro, nil
}
