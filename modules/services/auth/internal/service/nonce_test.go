package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/providers"
)

func sha256B64URL(s string) string {
	sum := sha256.Sum256([]byte(s))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// TestSigninNonce: a nonce in the request must match the id token's nonce
// claim (Google: equal, Apple: sha256 of the raw nonce, hex or unpadded
// base64url). Without a request nonce — every installed client today — the
// claim is not checked.
func TestSigninNonce(t *testing.T) {
	svc, stub := boot(t)
	ctx := t.Context()

	cases := []struct {
		name       string
		provider   string
		tokenNonce string
		reqNonce   string
		ok         bool
	}{
		{"google match", ProviderGoogle, "raw-g", "raw-g", true},
		{"google mismatch", ProviderGoogle, "raw-g", "other", false},
		{"google hashed is not equal", ProviderGoogle, sha256Hex("raw-g"), "raw-g", false},
		{"apple hashed match", ProviderApple, sha256Hex("raw-a"), "raw-a", true},
		{"apple base64url hashed match", ProviderApple, sha256B64URL("raw-a"), "raw-a", true},
		{"apple base64url of another nonce", ProviderApple, sha256B64URL("other"), "raw-a", false},
		{"apple padded base64 is not accepted", ProviderApple, sha256B64URL("raw-a") + "=", "raw-a", false},
		{"apple raw is not the hash", ProviderApple, "raw-a", "raw-a", false},
		{"request nonce, token without", ProviderApple, "", "raw-a", false},
		{"no request nonce, token with", ProviderGoogle, "raw-g", "", true},
		{"no nonce anywhere", ProviderApple, "", "", true},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub.Want = providers.Identity{Subject: "nonce-sub-" + string(rune('a'+i)), Nonce: tc.tokenNonce}
			in := SocialInput{IDToken: "stub", Nonce: tc.reqNonce}
			var err error
			if tc.provider == ProviderGoogle {
				_, err = svc.SigninGoogle(ctx, in)
			} else {
				_, err = svc.SigninApple(ctx, in)
			}
			if (err == nil) != tc.ok {
				t.Fatalf("signin accepted=%v, want %v (err=%v)", err == nil, tc.ok, err)
			}
		})
	}
}
