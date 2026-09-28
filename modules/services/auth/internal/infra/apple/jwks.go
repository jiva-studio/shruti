package apple

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"

	gjwt "github.com/golang-jwt/jwt/v5"
)

// keyfunc returns a Keyfunc that resolves the `kid` to an *rsa.PublicKey.
// The Keyfunc closes over a cached copy of the JWKS, refreshed every
// jwksCacheTTL (10 min). Apple rotates keys infrequently (months). An
// unknown kid forces one refetch, at most once per
// jwksForcedRefreshInterval across all callers.
func (v *Verifier) keyfunc(ctx context.Context) (gjwt.Keyfunc, error) {
	if err := v.ensureJWKS(ctx); err != nil {
		return nil, err
	}
	return func(token *gjwt.Token) (any, error) {
		kid, _ := token.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("missing kid")
		}
		if key, ok := v.cachedKey(kid); ok {
			return key, nil
		}
		if !v.claimForcedRefresh() {
			return nil, fmt.Errorf("unknown kid %q", kid)
		}
		if err := v.fetchShared(ctx, func() bool { return false }); err != nil {
			return nil, fmt.Errorf("refresh jwks for kid=%s: %w", kid, err)
		}
		if key, ok := v.cachedKey(kid); ok {
			return key, nil
		}
		return nil, fmt.Errorf("unknown kid %q", kid)
	}, nil
}

func (v *Verifier) cachedKey(kid string) (*rsa.PublicKey, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if v.rawCached == nil {
		return nil, false
	}
	key, ok := v.rawCached.byKID[kid]
	return key, ok
}

// claimForcedRefresh reports whether this caller may force a refetch, and
// if so records the attempt.
func (v *Verifier) claimForcedRefresh() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.clock()
	if !v.lastForcedAt.IsZero() && now.Sub(v.lastForcedAt) < jwksForcedRefreshInterval {
		return false
	}
	v.lastForcedAt = now
	return true
}

func (v *Verifier) fresh() bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return v.rawCached != nil && v.clock().Sub(v.jwksAt) <= jwksCacheTTL
}

func (v *Verifier) ensureJWKS(ctx context.Context) error {
	if v.fresh() {
		return nil
	}
	return v.fetchShared(ctx, v.fresh)
}

// fetchShared runs one JWKS fetch for all concurrent callers. skip is
// evaluated inside the shared call, so a caller arriving after another
// fetch filled the cache does not fetch again. The fetch is detached from
// the first caller's cancellation and bounded by the HTTP client timeout.
func (v *Verifier) fetchShared(ctx context.Context, skip func() bool) error {
	_, err, _ := v.fetches.Do("jwks", func() (any, error) {
		if skip() {
			return nil, nil
		}
		return nil, v.refreshJWKS(context.WithoutCancel(ctx))
	})
	return err
}

func (v *Verifier) refreshJWKS(ctx context.Context) error {
	url := jwksURL
	if v.JWKSURLOverride != "" {
		url = v.JWKSURLOverride
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %s", resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var doc jwksDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return fmt.Errorf("unmarshal: %w", err)
	}

	cache := &cachedKeys{byKID: map[string]*rsa.PublicKey{}}
	for _, k := range doc.Keys {
		if k.KTY != "RSA" || k.KID == "" {
			continue
		}
		pub, err := jwkToRSAPublicKey(k)
		if err != nil {
			continue
		}
		cache.byKID[k.KID] = pub
	}
	if len(cache.byKID) == 0 {
		return errors.New("jwks has no usable RSA keys")
	}

	v.mu.Lock()
	v.rawCached = cache
	v.jwksAt = v.clock()
	v.mu.Unlock()
	return nil
}

type cachedKeys struct {
	byKID map[string]*rsa.PublicKey
}

type jwksDoc struct {
	Keys []jwk `json:"keys"`
}

type jwk struct {
	KTY string `json:"kty"`
	KID string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
	Alg string `json:"alg"`
	Use string `json:"use"`
}

func jwkToRSAPublicKey(k jwk) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("decode n: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("decode e: %w", err)
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 + int(b)
	}
	if e == 0 {
		return nil, errors.New("zero exponent")
	}
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: e,
	}, nil
}
