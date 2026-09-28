package authjwt

import (
	"crypto/rsa"
	"encoding/pem"
	"fmt"
	"os"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Signer issues access and refresh tokens, always stamping kid=Kid. Only the
// auth service holds the private key.
type Signer struct {
	priv *rsa.PrivateKey
	now  func() time.Time
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
	return &Signer{priv: priv, now: time.Now}, nil
}

// IssueInput is every claim a caller may set. Audience is required:
// AudienceChat for an access token, AudienceAuth for a refresh token. A nil
// JTI gets a fresh one.
type IssueInput struct {
	UserID        uuid.UUID
	Anonymous     bool
	Tier          string
	QuotaID       string
	TierExpiresAt int64
	RCAppUserID   string
	Identities    []ClaimIdentity
	Audience      string
	TTL           time.Duration
	JTI           uuid.UUID
}

// Issue signs a token and returns it with its jti.
func (s *Signer) Issue(in IssueInput) (token string, jti uuid.UUID, err error) {
	jti = in.JTI
	if jti == uuid.Nil {
		jti = uuid.New()
	}
	now := s.now().UTC()
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
	tok.Header["kid"] = Kid
	signed, err := tok.SignedString(s.priv)
	if err != nil {
		return "", uuid.Nil, err
	}
	return signed, jti, nil
}
