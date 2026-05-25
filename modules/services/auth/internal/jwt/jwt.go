// Package jwt signs and verifies the auth service's own JWTs (RS256, kid="v1").
//
// JWT shape:
//
//	header:  { alg: "RS256", typ: "JWT", kid: "v1" }
//	payload: { sub, anonymous, tier, exp, iat, jti }
//
// `tier` is the subscription tier mirrored from RevenueCat ("free" | "pro").
// Empty / missing on old in-flight tokens — consumers default to "free".
package jwt

import (
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Claims is the JWT payload we issue. `Tier` was added 2026-05; tokens
// minted before that release omit it. The omitempty tag keeps them
// byte-identical for the free path so the chat-side verifier (which
// defaults missing tier to "free") sees no behaviour change.
type Claims struct {
	Anonymous bool   `json:"anonymous"`
	Tier      string `json:"tier,omitempty"`
	gjwt.RegisteredClaims
}

// Signer issues access + refresh tokens.
type Signer struct {
	priv *rsa.PrivateKey
	kid  string
}

// Verifier checks signature/exp of tokens issued by Signer. Holds a
// kid → public-key map so an operator can rotate signing keys without
// invalidating outstanding tokens: drop a `<new-kid>.pub.pem` file
// next to the old one, flip the signer's `JWT_KID`, and old + new
// tokens both validate until the old ones age out.
type Verifier struct {
	keys map[string]*rsa.PublicKey
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

// NewVerifierFromFile reads a single PEM-encoded RSA public key and
// registers it under kid "v1" (the default signer kid). Back-compat
// path for the single-file deploy.
func NewVerifierFromFile(path string) (*Verifier, error) {
	pub, err := loadPublicKey(path)
	if err != nil {
		return nil, err
	}
	return &Verifier{keys: map[string]*rsa.PublicKey{"v1": pub}}, nil
}

// NewVerifierFromDir scans `dir` for `*.pub.pem` files and registers
// each under its filename-derived kid (`v2.pub.pem` → kid "v2"). The
// legacy `public.pem` filename is mapped to kid "v1" so an operator
// can opt into multi-key mode by adding files without renaming the
// existing one.
func NewVerifierFromDir(dir string) (*Verifier, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.pub.pem"))
	if err != nil {
		return nil, fmt.Errorf("scan %s: %w", dir, err)
	}
	if legacy := filepath.Join(dir, "public.pem"); fileExists(legacy) {
		matches = append(matches, legacy)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, f := range matches {
		base := filepath.Base(f)
		kid := strings.TrimSuffix(base, ".pub.pem")
		if base == "public.pem" {
			kid = "v1"
		}
		pub, err := loadPublicKey(f)
		if err != nil {
			return nil, err
		}
		keys[kid] = pub
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("no public keys in %s (expected public.pem or *.pub.pem)", dir)
	}
	return &Verifier{keys: keys}, nil
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

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Issue signs a JWT. If jti is uuid.Nil a fresh one is generated.
// `tier` is the user's subscription tier ("free" | "pro"); empty string
// is fine — the chat-side verifier defaults to "free".
func (s *Signer) Issue(userID uuid.UUID, anonymous bool, tier string, ttl time.Duration, jti uuid.UUID) (token string, generatedJTI uuid.UUID, err error) {
	if jti == uuid.Nil {
		jti = uuid.New()
	}
	now := time.Now().UTC()
	claims := Claims{
		Anonymous: anonymous,
		Tier:      tier,
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
// Looks up the public key by the token's `kid` header; tokens without
// a kid (or with an unknown one) are rejected. Legacy tokens that
// pre-date kid emission still validate because the signer has been
// stamping kid="v1" since day one.
func (v *Verifier) Verify(token string) (*Claims, error) {
	claims := &Claims{}
	_, err := gjwt.ParseWithClaims(token, claims, func(t *gjwt.Token) (any, error) {
		if _, ok := t.Method.(*gjwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected alg %v", t.Header["alg"])
		}
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			// Single-key deploys never set kid pre-rotation; assume v1.
			kid = "v1"
		}
		key, ok := v.keys[kid]
		if !ok {
			return nil, fmt.Errorf("unknown kid %q", kid)
		}
		return key, nil
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
