// Package jwt signs and verifies the auth service's own JWTs (RS256, kid="v1").
//
// JWT shape:
//
//	header:  { alg: "RS256", typ: "JWT", kid: "v1" }
//	payload: { sub: <user-uuid>, anonymous: bool, exp, iat, jti }
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

// Claims is the JWT payload we issue.
type Claims struct {
	Anonymous bool `json:"anonymous"`
	gjwt.RegisteredClaims
}

// Signer issues access + refresh tokens.
type Signer struct {
	priv *rsa.PrivateKey
	kid  string
}

// Verifier checks signature/exp of tokens issued by Signer.
type Verifier struct {
	pub *rsa.PublicKey
}

// NewSignerFromFile reads a PEM-encoded RSA private key.
func NewSignerFromFile(path, kid string) (*Signer, error) {
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
	return &Signer{priv: priv, kid: kid}, nil
}

// NewVerifierFromFile reads a PEM-encoded RSA public key.
func NewVerifierFromFile(path string) (*Verifier, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read public key %s: %w", path, err)
	}
	pub, err := gjwt.ParseRSAPublicKeyFromPEM(b)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}
	return &Verifier{pub: pub}, nil
}

// Issue signs a JWT. If jti is uuid.Nil a fresh one is generated.
func (s *Signer) Issue(userID uuid.UUID, anonymous bool, ttl time.Duration, jti uuid.UUID) (token string, generatedJTI uuid.UUID, err error) {
	if jti == uuid.Nil {
		jti = uuid.New()
	}
	now := time.Now().UTC()
	claims := Claims{
		Anonymous: anonymous,
		RegisteredClaims: gjwt.RegisteredClaims{
			Subject:   userID.String(),
			IssuedAt:  gjwt.NewNumericDate(now),
			ExpiresAt: gjwt.NewNumericDate(now.Add(ttl)),
			ID:        jti.String(),
		},
	}
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
	tok.Header["kid"] = s.kid
	signed, err := tok.SignedString(s.priv)
	if err != nil {
		return "", uuid.Nil, err
	}
	return signed, jti, nil
}

// Verify parses and checks signature + exp. Returns claims if valid.
func (v *Verifier) Verify(token string) (*Claims, error) {
	claims := &Claims{}
	_, err := gjwt.ParseWithClaims(token, claims, func(t *gjwt.Token) (any, error) {
		if _, ok := t.Method.(*gjwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected alg %v", t.Header["alg"])
		}
		return v.pub, nil
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
