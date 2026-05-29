// Package jwt signs and verifies the auth service's own JWTs (RS256, kid="v1").
//
// JWT shape:
//
//	header:  { alg: "RS256", typ: "JWT", kid: "v1" }
//	payload: { sub, anonymous, tier, tier_expires_at, exp, iat, jti }
//
// `tier` is the subscription tier mirrored from RevenueCat ("free" | "pro").
// Empty / missing on old in-flight tokens — consumers default to "free".
// `tier_expires_at` is UNIX-epoch seconds; 0 means lifetime or free. Chat-side
// rate limiter downgrades a "pro" claim whose expiry is in the past, so a
// stale RENEWAL/EXPIRATION webhook can't keep a free user on Pro past expiry.
package jwt

import (
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// SignerKid is the single key id stamped into every JWT this service
// issues. Multi-kid rotation was abandoned with the single-region
// collapse (#728); the verifier accepts only this id.
const SignerKid = "v1"

// ClaimIdentity is one identity row mirrored into the JWT so the chat
// service can rebuild a user's social-identity set without round-tripping
// to the auth service. `EmailHash` is sha256(lower(trim(email))) — never
// the raw email. The `Email.Enabled` profile policy gates whether
// EmailHash + EmailVerified are emitted (see profile.BuildClaims).
type ClaimIdentity struct {
	Provider      string `json:"p"`
	Subject       string `json:"s"`
	EmailHash     string `json:"eh,omitempty"`
	EmailVerified bool   `json:"ev,omitempty"`
}

// Claims is the JWT payload we issue. `Tier` and `QuotaID` were added
// 2026-05; tokens minted before that release omit them. The omitempty
// tag keeps the free / anonymous path byte-identical so the chat-side
// verifier (which defaults missing tier to "free" and falls back to
// `sub` when quota_id is empty) sees no behaviour change.
//
// QuotaID is a sha256 of the user's earliest identity (non-device when
// available, falling back to a per-device hash for anon users since
// PR-1). The chat rate-limiter keys per-user counters on it instead of
// `sub` so a delete+recreate doesn't refresh today's quota — see
// internal/identityhash and issue #626.
//
// Identities and RCAppUserID land in the claim so the chat service can
// derive its own per-user state (rate-limit keys, audit fields) without
// a round trip. Audience is populated via RegisteredClaims.Audience:
// "chat" on access tokens, "auth" on refresh tokens; chat-side verifier
// pins audience="chat".
type Claims struct {
	Anonymous bool   `json:"anonymous"`
	Tier      string `json:"tier,omitempty"`
	QuotaID   string `json:"quota_id,omitempty"`
	// TierExpiresAt is the UNIX-epoch (seconds) at which the embedded
	// `tier` expires. 0 means lifetime (Pro that never expires) or free
	// (no expiry concept). Chat-side verifier coerces `tier="pro"` with
	// a past `tier_expires_at` to "free" so a missed EXPIRATION webhook
	// can't extend Pro past its real boundary.
	TierExpiresAt int64           `json:"tier_expires_at,omitempty"`
	RCAppUserID   string          `json:"rc_aid,omitempty"`
	Identities    []ClaimIdentity `json:"ids,omitempty"`
	gjwt.RegisteredClaims
}

// Audience strings stamped into `aud`. Access tokens are bound to the
// chat service; refresh tokens go back to /auth/refresh. Chat-side
// verifier pins audience="chat" and rejects mismatches with
// InvalidAudienceError.
const (
	AudienceChat = "chat"
	AudienceAuth = "auth"
)

// Signer issues access + refresh tokens. Always stamps kid=SignerKid.
type Signer struct {
	priv *rsa.PrivateKey
}

// Verifier checks signature/exp of tokens issued by Signer.
type Verifier struct {
	key *rsa.PublicKey
}

// NewSignerFromFile reads a PEM-encoded RSA private key.
func NewSignerFromFile(path string) (*Signer, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read private key %s: %w", path, err)
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, fmt.Errorf("no PEM block in %s", path)
	}
	priv, err := gjwt.ParseRSAPrivateKeyFromPEM(b)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	return &Signer{priv: priv}, nil
}

// NewVerifierFromFile reads a single PEM-encoded RSA public key.
func NewVerifierFromFile(path string) (*Verifier, error) {
	pub, err := loadPublicKey(path)
	if err != nil {
		return nil, err
	}
	return &Verifier{key: pub}, nil
}

func loadPublicKey(path string) (*rsa.PublicKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read public key %s: %w", path, err)
	}
	pub, err := gjwt.ParseRSAPublicKeyFromPEM(b)
	if err != nil {
		return nil, fmt.Errorf("parse public key %s: %w", path, err)
	}
	return pub, nil
}

// IssueInput bundles every claim a caller may want to set. Use this
// instead of a long positional argument list — the call sites in
// service.go would otherwise be six fields of bool/string at the call
// boundary with no contextual cues, easy to mis-order.
type IssueInput struct {
	UserID        uuid.UUID
	Anonymous     bool
	Tier          string
	QuotaID       string
	TierExpiresAt int64
	RCAppUserID   string
	Identities    []ClaimIdentity
	Audience      string // AudienceChat or AudienceAuth; required
	TTL           time.Duration
	JTI           uuid.UUID // uuid.Nil → fresh one is generated
}

// Issue signs a JWT.
//
// `Tier` is the user's subscription tier ("free" | "pro"); empty string
// is fine — the chat-side verifier defaults to "free".
//
// `TierExpiresAt` is UNIX-epoch seconds at which `tier` expires. 0 means
// lifetime / free (no expiry). The chat-side limiter coerces an expired
// "pro" claim back to free limits.
//
// `QuotaID` is a stable hash of the user's earliest identity (see
// internal/identityhash). Since PR-1 it is non-empty even for anonymous
// users — derived from the device subject — so anon quota enforcement
// can key on a stable per-device hash instead of falling back to `sub`.
//
// `Audience` is required and stamped into `aud`. Use AudienceChat for
// access tokens and AudienceAuth for refresh tokens.
func (s *Signer) Issue(in IssueInput) (token string, generatedJTI uuid.UUID, err error) {
	jti := in.JTI
	if jti == uuid.Nil {
		jti = uuid.New()
	}
	now := time.Now().UTC()
	claims := Claims{
		Anonymous:     in.Anonymous,
		Tier:          in.Tier,
		QuotaID:       in.QuotaID,
		TierExpiresAt: in.TierExpiresAt,
		RCAppUserID:   in.RCAppUserID,
		Identities:    in.Identities,
		RegisteredClaims: gjwt.RegisteredClaims{
			Subject:   in.UserID.String(),
			Audience:  gjwt.ClaimStrings{in.Audience},
			IssuedAt:  gjwt.NewNumericDate(now),
			ExpiresAt: gjwt.NewNumericDate(now.Add(in.TTL)),
			ID:        jti.String(),
		},
	}
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
	tok.Header["kid"] = SignerKid
	signed, err := tok.SignedString(s.priv)
	if err != nil {
		return "", uuid.Nil, err
	}
	return signed, jti, nil
}

// Verify parses and checks signature + exp. Returns claims if valid.
// The kid header is required and must equal SignerKid ("v1") — tokens
// without a kid, or with a foreign kid, are rejected. This is
// symmetric with the chat-service Python verifier and forecloses the
// failure mode where a stale `<other-kid>.pub.pem` (e.g. from a
// retired region) is somehow trusted by another service in the stack.
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

// JTI extracts the jti from a verified Claims.
func (c *Claims) JTI() (uuid.UUID, error) {
	if c.ID == "" {
		return uuid.Nil, errors.New("missing jti")
	}
	return uuid.Parse(c.ID)
}

// UserID extracts the sub from verified Claims as a UUID.
func (c *Claims) UserID() (uuid.UUID, error) {
	return uuid.Parse(c.Subject)
}
