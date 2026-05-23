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
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
)

// keyfunc returns a Keyfunc that resolves the `kid` to an *rsa.PublicKey.
// The Keyfunc closes over a cached copy of the JWKS, refreshed every
// jwksCacheTTL (10 min). Apple rotates keys infrequently (months).
func (v *Verifier) keyfunc(ctx context.Context) (gjwt.Keyfunc, error) {
	if err := v.ensureJWKS(ctx); err != nil {
		return nil, err
	}
	return func(token *gjwt.Token) (any, error) {
		kid, _ := token.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("missing kid")
		}
		v.mu.RLock()
		cache := v.rawCached
		v.mu.RUnlock()
		key, ok := cache.byKID[kid]
		if !ok {
			// Force refresh and retry once — possibly a new key rotated in.
			if err := v.refreshJWKS(ctx); err != nil {
				return nil, fmt.Errorf("refresh jwks for kid=%s: %w", kid, err)
			}
			v.mu.RLock()
			cache = v.rawCached
			v.mu.RUnlock()
			key, ok = cache.byKID[kid]
			if !ok {
				return nil, fmt.Errorf("unknown kid %q", kid)
			}
		}
		return key, nil
	}, nil
}

func (v *Verifier) ensureJWKS(ctx context.Context) error {
	v.mu.RLock()
	stale := v.rawCached == nil || time.Since(v.jwksAt) > jwksCacheTTL
	v.mu.RUnlock()
	if !stale {
		return nil
	}
	return v.refreshJWKS(ctx)
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
	v.jwksAt = time.Now()
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
