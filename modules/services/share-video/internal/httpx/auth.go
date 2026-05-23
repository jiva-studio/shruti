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

// JWTVerifier reads, caches, and validates RS256 tokens against the
// public key auth-service mounts at JWT_PUBLIC_KEY_PATH.
type JWTVerifier struct {
	keyPath string
	once    sync.Once
	key     *rsa.PublicKey
	loadErr error
}

func NewJWTVerifier(keyPath string) *JWTVerifier {
	return &JWTVerifier{keyPath: keyPath}
}

func (v *JWTVerifier) publicKey() (*rsa.PublicKey, error) {
	v.once.Do(func() {
		raw, err := os.ReadFile(v.keyPath)
		if err != nil {
			v.loadErr = fmt.Errorf("read %s: %w", v.keyPath, err)
			return
		}
		key, err := jwt.ParseRSAPublicKeyFromPEM(raw)
		if err != nil {
			v.loadErr = fmt.Errorf("parse pubkey: %w", err)
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

		key, err := v.publicKey()
		if err != nil {
			writeError(w, http.StatusUnauthorized, "auth not configured")
			return
		}

		parser := jwt.NewParser(
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithLeeway(30*time.Second),
		)
		token, err := parser.Parse(tokenStr, func(t *jwt.Token) (any, error) {
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
