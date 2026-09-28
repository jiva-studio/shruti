package apple

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type jwksStub struct {
	srv     *httptest.Server
	priv    *rsa.PrivateKey
	kid     string
	hits    atomic.Int64
	arrived chan struct{} // one value per fetch
}

// newJWKSStub serves one key and counts fetches. When gate is non-nil
// every fetch waits on it, so concurrent callers pile up.
func newJWKSStub(t *testing.T, gate <-chan struct{}) *jwksStub {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	s := &jwksStub{priv: key, kid: "COUNT_KID", arrived: make(chan struct{}, 64)}
	doc := jwksDoc{Keys: []jwk{{
		KTY: "RSA", KID: s.kid, Alg: "RS256", Use: "sig",
		N: base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		E: base64.RawURLEncoding.EncodeToString([]byte{0x01, 0x00, 0x01}),
	}}}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.hits.Add(1)
		s.arrived <- struct{}{}
		if gate != nil {
			<-gate
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(doc); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

// TestUnknownKidBurstFetchesJWKSOnce: tokens with unknown kids trigger at
// most one forced JWKS refetch per minute, so a stream of forged tokens
// cannot turn the auth service into a request amplifier against Apple.
func TestUnknownKidBurstFetchesJWKSOnce(t *testing.T) {
	s := newJWKSStub(t, nil)
	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = s.srv.URL

	for i := 0; i < 10; i++ {
		tok := signAppleStyle(t, s.priv, "FORGED_KID", "studio.jiva.shruti", "u1", true, nil)
		if _, err := v.Verify(t.Context(), tok); err == nil {
			t.Fatal("unknown kid verified")
		}
	}
	// One fetch to fill the cache, one forced refetch for the unknown kid.
	if got := s.hits.Load(); got != 2 {
		t.Fatalf("JWKS fetched %d times for 10 unknown-kid tokens, want 2", got)
	}
}

// TestForcedRefetchAllowedAfterInterval: a key Apple rotates in is picked
// up by the first unknown-kid token once the forced-refetch interval has
// passed.
func TestForcedRefetchAllowedAfterInterval(t *testing.T) {
	s := newJWKSStub(t, nil)
	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = s.srv.URL
	now := time.Now()
	v.clock = func() time.Time { return now }

	forged := signAppleStyle(t, s.priv, "FORGED_KID", "studio.jiva.shruti", "u1", true, nil)
	for i := 0; i < 3; i++ {
		if _, err := v.Verify(t.Context(), forged); err == nil {
			t.Fatal("unknown kid verified")
		}
	}
	if got := s.hits.Load(); got != 2 {
		t.Fatalf("fetches before the interval: %d, want 2", got)
	}
	now = now.Add(jwksForcedRefreshInterval + time.Second)
	if _, err := v.Verify(t.Context(), forged); err == nil {
		t.Fatal("unknown kid verified")
	}
	// The cache TTL has not passed, so the one extra fetch is the forced one.
	if got := s.hits.Load(); got != 3 {
		t.Fatalf("fetches after the interval: %d, want 3", got)
	}
}

// TestSharedFetchSkipsWhenCacheFilled: a caller that joins after another
// fetch has filled the cache does not fetch again.
func TestSharedFetchSkipsWhenCacheFilled(t *testing.T) {
	s := newJWKSStub(t, nil)
	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = s.srv.URL
	if err := v.ensureJWKS(t.Context()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if err := v.fetchShared(t.Context(), v.fresh); err != nil {
		t.Fatalf("fetchShared: %v", err)
	}
	if got := s.hits.Load(); got != 1 {
		t.Fatalf("JWKS fetched %d times, want 1", got)
	}
}

// TestConcurrentColdVerifiesShareOneFetch: concurrent verifies on an empty
// cache wait for a single JWKS fetch.
func TestConcurrentColdVerifiesShareOneFetch(t *testing.T) {
	gate := make(chan struct{})
	s := newJWKSStub(t, gate)
	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = s.srv.URL
	tok := signAppleStyle(t, s.priv, s.kid, "studio.jiva.shruti", "u1", true, nil)

	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := v.Verify(t.Context(), tok)
			errs <- err
		}()
	}
	<-s.arrived // the first fetch is in flight
	close(gate)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("verify: %v", err)
		}
	}
	if got := s.hits.Load(); got != 1 {
		t.Fatalf("JWKS fetched %d times for %d concurrent cold verifies, want 1", got, n)
	}
}
