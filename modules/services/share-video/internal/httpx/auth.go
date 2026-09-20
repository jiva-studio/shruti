package httpx

import (
	"context"
	"crypto/rsa"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// SignerKid mirrors auth/internal/jwt.SignerKid — the single key id every
// token issued by the auth service carries since the #728 single-region
// collapse. The verifier here pins this id and rejects anything else, so
// a stale `<other>.pub.pem` left on disk after a redeploy cannot validate
// tokens forged with the matching private key.
const SignerKid = "v1"

const AccessAudience = "chat"

type CurrentUser struct {
	ID        string
	Anonymous bool
}

type userKey struct{}

// UserFrom returns the JWT-verified caller from request context. Set by
// RequireAuth; absent means the request was unauthenticated.
func UserFrom(ctx context.Context) (CurrentUser, bool) {
	u, ok := ctx.Value(userKey{}).(CurrentUser)
	return u, ok
}

// JWTVerifier reads, caches, and validates RS256 tokens issued by the
// auth service. Single-key deploy: one public.pem mapped to kid="v1".
// Multi-kid rotation was deleted with the single-region collapse (#728);
// scanning a directory for `<kid>.pub.pem` files was a footgun because a
// stale pubkey from a retired region (e.g. russia-v1) would still verify
// tokens until the operator manually swept the directory.
type JWTVerifier struct {
	keyPath string
	once    sync.Once
	key     *rsa.PublicKey
	loadErr error
}

// NewJWTVerifier wires the verifier to a single public key file. The
// token's kid header must equal SignerKid ("v1") or verification fails.
func NewJWTVerifier(keyPath string) *JWTVerifier {
	return &JWTVerifier{keyPath: keyPath}
}

func (v *JWTVerifier) loadKey() (*rsa.PublicKey, error) {
	v.once.Do(func() {
		raw, err := os.ReadFile(v.keyPath)
		if err != nil {
			v.loadErr = fmt.Errorf("read %s: %w", v.keyPath, err)
			return
		}
		key, err := jwt.ParseRSAPublicKeyFromPEM(raw)
		if err != nil {
			v.loadErr = fmt.Errorf("parse %s: %w", v.keyPath, err)
			return
		}
		v.key = key
	})
	return v.key, v.loadErr
}

// RequireAuth is the chi-style middleware that fronts /reels endpoints.
// 30 s clock leeway covers iat-skew between auth-service and share-video
// host (jsonwebtoken doesn't trip on small skews; golang-jwt/v5 needs
// the explicit option).
func (v *JWTVerifier) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		tokenStr := strings.TrimPrefix(h, "Bearer ")

		key, err := v.loadKey()
		if err != nil {
			writeError(w, http.StatusUnauthorized, "auth not configured")
			return
		}

		parser := jwt.NewParser(
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithAudience(AccessAudience),
			jwt.WithLeeway(30*time.Second),
		)
		token, err := parser.Parse(tokenStr, func(t *jwt.Token) (any, error) {
			kid, _ := t.Header["kid"].(string)
			if kid != SignerKid {
				return nil, fmt.Errorf("unexpected kid %q (want %q)", kid, SignerKid)
			}
			return key, nil
		})
		if err != nil || !token.Valid {
			writeError(w, http.StatusUnauthorized, fmt.Sprintf("invalid token: %s", errMsg(err)))
			return
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			writeError(w, http.StatusUnauthorized, "invalid token payload")
			return
		}
		sub, err := claims.GetSubject()
		if err != nil || strings.TrimSpace(sub) == "" {
			writeError(w, http.StatusUnauthorized, "missing sub claim")
			return
		}

		// `claims.anonymous ?? true` parity — absent or null → true,
		// explicit boolean is honoured exactly.
		anon := true
		if v, present := claims["anonymous"]; present {
			if b, ok := v.(bool); ok {
				anon = b
			}
		}

		ctx := context.WithValue(r.Context(), userKey{}, CurrentUser{ID: sub, Anonymous: anon})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func errMsg(err error) string {
	if err == nil {
		return "unknown"
	}
	return err.Error()
}
