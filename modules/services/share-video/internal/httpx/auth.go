package httpx

import (
	"context"
	"crypto/rsa"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
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

// JWTVerifier reads, caches, and validates RS256 tokens issued by the
// auth service. Holds a kid → public-key map so the auth side can
// rotate signing keys without invalidating outstanding tokens.
type JWTVerifier struct {
	keyPath string // legacy single-file path; empty when keysDir is set
	keysDir string // optional dir with `<kid>.pub.pem` files
	once    sync.Once
	keys    map[string]*rsa.PublicKey
	loadErr error
}

// NewJWTVerifier wires the verifier to a single public key file
// (legacy single-key deploy). The token's kid is matched against "v1".
func NewJWTVerifier(keyPath string) *JWTVerifier {
	return &JWTVerifier{keyPath: keyPath}
}

// NewJWTVerifierFromDir scans `dir` for `<kid>.pub.pem` files at the
// first verify call. The legacy `public.pem` filename is mapped to
// kid "v1" so an operator can opt into multi-key mode by adding files
// to the existing directory without renaming.
func NewJWTVerifierFromDir(dir string) *JWTVerifier {
	return &JWTVerifier{keysDir: dir}
}

func (v *JWTVerifier) loadKeys() (map[string]*rsa.PublicKey, error) {
	v.once.Do(func() {
		v.keys = map[string]*rsa.PublicKey{}
		paths, kids := v.keyPaths()
		if v.loadErr != nil {
			return
		}
		for i, p := range paths {
			raw, err := os.ReadFile(p)
			if err != nil {
				v.loadErr = fmt.Errorf("read %s: %w", p, err)
				return
			}
			key, err := jwt.ParseRSAPublicKeyFromPEM(raw)
			if err != nil {
				v.loadErr = fmt.Errorf("parse %s: %w", p, err)
				return
			}
			v.keys[kids[i]] = key
		}
		if len(v.keys) == 0 {
			v.loadErr = fmt.Errorf("no public keys to load")
		}
	})
	return v.keys, v.loadErr
}

// keyPaths returns parallel slices of (file, kid). Legacy `public.pem`
// is always tagged as v1; other `*.pub.pem` files get their basename.
func (v *JWTVerifier) keyPaths() (paths []string, kids []string) {
	if v.keysDir == "" {
		return []string{v.keyPath}, []string{"v1"}
	}
	matches, err := filepath.Glob(filepath.Join(v.keysDir, "*.pub.pem"))
	if err != nil {
		v.loadErr = fmt.Errorf("scan %s: %w", v.keysDir, err)
		return nil, nil
	}
	for _, p := range matches {
		kid := strings.TrimSuffix(filepath.Base(p), ".pub.pem")
		paths = append(paths, p)
		kids = append(kids, kid)
	}
	if legacy := filepath.Join(v.keysDir, "public.pem"); fileExists(legacy) {
		paths = append(paths, legacy)
		kids = append(kids, "v1")
	}
	return paths, kids
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
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

		keys, err := v.loadKeys()
		if err != nil {
			writeError(w, http.StatusUnauthorized, "auth not configured")
			return
		}

		parser := jwt.NewParser(
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithLeeway(30*time.Second),
		)
		token, err := parser.Parse(tokenStr, func(t *jwt.Token) (any, error) {
			kid, _ := t.Header["kid"].(string)
			if kid == "" {
				kid = "v1"
			}
			key, ok := keys[kid]
			if !ok {
				return nil, fmt.Errorf("unknown kid %q", kid)
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
