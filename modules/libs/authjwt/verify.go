package authjwt

import (
	"crypto/rsa"
	"errors"
	"fmt"
	"os"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
)

// ErrNotAccessToken is returned by VerifyAccess for a validly signed token
// whose `aud` does not contain "chat" — a refresh token, or one minted for
// someone else.
var ErrNotAccessToken = errors.New("token audience must include chat")

// ErrNotRefreshToken is returned by VerifyRefresh for a validly signed access
// token.
var ErrNotRefreshToken = errors.New("access token presented as refresh token")

// Verifier checks tokens signed by the auth service's private key, one method
// per token kind.
type Verifier struct {
	key    *rsa.PublicKey
	leeway time.Duration
}

// Option adjusts a Verifier.
type Option func(*Verifier)

// WithLeeway tolerates clock skew of d between the signer and this host when
// checking `exp`, `nbf` and `iat`.
func WithLeeway(d time.Duration) Option {
	return func(v *Verifier) { v.leeway = d }
}

// NewVerifier builds a Verifier over a parsed public key.
func NewVerifier(key *rsa.PublicKey, opts ...Option) (*Verifier, error) {
	if key == nil {
		return nil, errors.New("authjwt: nil public key")
	}
	v := &Verifier{key: key}
	for _, o := range opts {
		o(v)
	}
	return v, nil
}

// NewVerifierFromFile reads a single PEM-encoded RSA public key.
func NewVerifierFromFile(path string, opts ...Option) (*Verifier, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read public key %s: %w", path, err)
	}
	pub, err := gjwt.ParseRSAPublicKeyFromPEM(b)
	if err != nil {
		return nil, fmt.Errorf("parse public key %s: %w", path, err)
	}
	return NewVerifier(pub, opts...)
}

// VerifyAccess accepts only an access token: signature, kid, a required `exp`
// in the future, `aud` containing "chat" and a non-empty `sub`. The audience
// is checked after the signature and expiry, so ErrNotAccessToken always names
// a token that is otherwise valid.
func (v *Verifier) VerifyAccess(token string) (*Claims, error) {
	claims, err := v.parse(token)
	if err != nil {
		return nil, err
	}
	if !claims.HasAudience(AudienceChat) {
		return nil, ErrNotAccessToken
	}
	if claims.Subject == "" {
		return nil, errors.New("missing sub")
	}
	return claims, nil
}

// VerifyRefresh accepts only a refresh token: signature, kid, a required
// `exp` in the future, and an `aud` that does not contain "chat". A token
// without `aud` is accepted as a refresh token; the auth database decides
// whether it is still live.
func (v *Verifier) VerifyRefresh(token string) (*Claims, error) {
	claims, err := v.parse(token)
	if err != nil {
		return nil, err
	}
	if claims.HasAudience(AudienceChat) {
		return nil, ErrNotRefreshToken
	}
	return claims, nil
}

// parse checks the signature, the algorithm, the kid header and the
// registered time claims, with `exp` required.
func (v *Verifier) parse(token string) (*Claims, error) {
	claims := &Claims{}
	_, err := gjwt.ParseWithClaims(token, claims, func(t *gjwt.Token) (any, error) {
		if _, ok := t.Method.(*gjwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected alg %v", t.Header["alg"])
		}
		kid, ok := t.Header["kid"].(string)
		if !ok || kid != Kid {
			return nil, fmt.Errorf("unexpected kid %q (want %q)", kid, Kid)
		}
		return v.key, nil
	},
		gjwt.WithValidMethods([]string{"RS256"}),
		gjwt.WithExpirationRequired(),
		gjwt.WithLeeway(v.leeway),
	)
	if err != nil {
		return nil, err
	}
	return claims, nil
}
