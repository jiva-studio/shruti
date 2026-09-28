// Package authjwt signs and verifies the auth service's own JWTs (RS256,
// kid="v1").
//
// JWT shape:
//
//	header:  { alg: "RS256", typ: "JWT", kid: "v1" }
//	payload: { sub, anonymous, tier, tier_expires_at, quota_id, rc_aid, ids,
//	           aud, exp, iat, jti }
//
// An access token carries aud="chat" and is what every service accepts as a
// bearer credential; a refresh token carries aud="auth" and is accepted only by
// the auth service's refresh flow.
package authjwt

import (
	"errors"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Kid is the single key id stamped into every token; the verifier accepts
// only this id, so a stale public key left on disk cannot validate anything.
const Kid = "v1"

// Audience strings stamped into `aud`.
const (
	AudienceChat = "chat"
	AudienceAuth = "auth"
)

// ClaimIdentity is one identity row mirrored into the token so a consumer can
// rebuild a user's social-identity set without asking the auth service.
// EmailHash is sha256(lower(trim(email))), never the raw email.
type ClaimIdentity struct {
	Provider      string `json:"p"`
	Subject       string `json:"s"`
	EmailHash     string `json:"eh,omitempty"`
	EmailVerified bool   `json:"ev,omitempty"`
}

// Claims is the token payload.
//
// Tier is "free" or "pro"; a consumer treats an empty tier as "free".
// TierExpiresAt is UNIX-epoch seconds at which the tier lapses, 0 meaning
// lifetime or free; a consumer treats a "pro" claim whose expiry has passed as
// free. QuotaID is a stable hash of the user's earliest identity, the key the
// chat rate limiter counts under so deleting and recreating an account does
// not reset today's quota.
type Claims struct {
	Anonymous     bool            `json:"anonymous"`
	Tier          string          `json:"tier,omitempty"`
	QuotaID       string          `json:"quota_id,omitempty"`
	TierExpiresAt int64           `json:"tier_expires_at,omitempty"`
	RCAppUserID   string          `json:"rc_aid,omitempty"`
	Identities    []ClaimIdentity `json:"ids,omitempty"`
	gjwt.RegisteredClaims
}

// UserID returns the subject as a UUID.
func (c *Claims) UserID() (uuid.UUID, error) {
	return uuid.Parse(c.Subject)
}

// JTI returns the token id as a UUID.
func (c *Claims) JTI() (uuid.UUID, error) {
	if c.ID == "" {
		return uuid.Nil, errors.New("missing jti")
	}
	return uuid.Parse(c.ID)
}

// HasAudience reports whether `aud` contains want.
func (c *Claims) HasAudience(want string) bool {
	for _, a := range c.Audience {
		if a == want {
			return true
		}
	}
	return false
}
