package apple

import "testing"

func TestAppleVerifyExtractsNonce(t *testing.T) {
	srv, priv, kid := fakeJWKSServer(t)
	defer srv.Close()
	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = srv.URL

	tok := signAppleStyle(t, priv, kid, "studio.jiva.shruti", "u1", true, map[string]any{"nonce": "abc123"})
	id, err := v.Verify(t.Context(), tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if id.Nonce != "abc123" {
		t.Fatalf("nonce = %q, want abc123", id.Nonce)
	}
}
