package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func sign(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return strings.ToUpper(hex.EncodeToString(mac.Sum(nil)))
}

func TestVerifyHMAC(t *testing.T) {
	body := []byte(`{"OrderId":"abc","OrderStatus":8}`)
	secret := "topsecret"

	good := sign(body, secret)
	if !verifyHMAC(body, good, secret) {
		t.Fatal("valid signature rejected")
	}
	// lowercase header should still pass (we uppercase both sides)
	if !verifyHMAC(body, strings.ToLower(good), secret) {
		t.Fatal("valid lowercase signature rejected")
	}
	if verifyHMAC(body, good, "wrongsecret") {
		t.Fatal("signature accepted under wrong secret")
	}
	if verifyHMAC(body, "deadbeef", secret) {
		t.Fatal("bad signature accepted")
	}
	if verifyHMAC(body, "", secret) {
		t.Fatal("empty signature accepted")
	}
	// tampered body
	if verifyHMAC([]byte(`{"OrderId":"abc","OrderStatus":9}`), good, secret) {
		t.Fatal("signature accepted for tampered body")
	}
}

func TestDollars(t *testing.T) {
	cases := map[int]string{299: "2.99", 2999: "29.99", 100: "1.00", 5: "0.05", 0: "0.00"}
	for cents, want := range cases {
		if got := dollars(cents); got != want {
			t.Errorf("dollars(%d) = %q, want %q", cents, got, want)
		}
	}
}
