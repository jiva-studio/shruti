// Package authjwt reads the PRO entitlement out of the auth service's access
// tokens. The token itself is verified by the shared verifier; this adapter
// adds the orchestrator's reading of `tier` / `tier_expires_at`, re-checked at
// ingest time so a lapsed Pro tier can't ride a stale enqueued request through
// the pipeline.
package authjwt

import (
	"time"

	"github.com/jiva-studio/shruti/authjwt"
)

// Verifier checks an access token and evaluates the PRO entitlement.
type Verifier struct {
	tokens *authjwt.Verifier
	now    func() time.Time
}

// NewFromFile reads a single PEM-encoded RSA public key.
func NewFromFile(path string) (*Verifier, error) {
	tokens, err := authjwt.NewVerifierFromFile(path)
	if err != nil {
		return nil, err
	}
	return &Verifier{tokens: tokens, now: time.Now}, nil
}

// VerifyPro verifies an access token, then reports the subject and whether it
// grants an ACTIVE pro tier. A "pro" claim whose tier_expires_at is in the past
// is not pro: a missed EXPIRATION webhook can't extend Pro.
func (v *Verifier) VerifyPro(token string) (string, bool, error) {
	c, err := v.tokens.VerifyAccess(token)
	if err != nil {
		return "", false, err
	}
	pro := c.Tier == "pro" &&
		(c.TierExpiresAt == 0 || time.Unix(c.TierExpiresAt, 0).After(v.now()))
	return c.Subject, pro, nil
}
