package httpx

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jiva-studio/shruti/authjwt"
)

// clockLeeway covers iat/exp skew between the auth service and this host.
const clockLeeway = 30 * time.Second

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

// JWTVerifier verifies the auth service's access tokens against one public
// key file, read on first use. A key that cannot be read leaves every
// authenticated route answering 401 rather than keeping the service down.
type JWTVerifier struct {
	keyPath  string
	once     sync.Once
	verifier *authjwt.Verifier
	loadErr  error
}

// NewJWTVerifier wires the verifier to a single public key file.
func NewJWTVerifier(keyPath string) *JWTVerifier {
	return &JWTVerifier{keyPath: keyPath}
}

func (v *JWTVerifier) load() (*authjwt.Verifier, error) {
	v.once.Do(func() {
		v.verifier, v.loadErr = authjwt.NewVerifierFromFile(v.keyPath, authjwt.WithLeeway(clockLeeway))
	})
	return v.verifier, v.loadErr
}

// RequireAuth is the chi-style middleware that fronts /reels endpoints.
func (v *JWTVerifier) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		tokenStr := strings.TrimPrefix(h, "Bearer ")

		verifier, err := v.load()
		if err != nil {
			writeError(w, http.StatusUnauthorized, "auth not configured")
			return
		}
		claims, err := verifier.VerifyAccess(tokenStr)
		if err != nil {
			writeError(w, http.StatusUnauthorized, fmt.Sprintf("invalid token: %s", err))
			return
		}
		if strings.TrimSpace(claims.Subject) == "" {
			writeError(w, http.StatusUnauthorized, "missing sub claim")
			return
		}

		ctx := context.WithValue(r.Context(), userKey{}, CurrentUser{ID: claims.Subject, Anonymous: claims.Anonymous})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
