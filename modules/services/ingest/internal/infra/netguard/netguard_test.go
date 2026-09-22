package netguard

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestCheckURLBlocksNonPublicLiterals(t *testing.T) {
	blocked := []struct{ name, url string }{
		{"cloud metadata", "http://169.254.169.254/latest/meta-data/x.mp3"},
		{"loopback", "http://127.0.0.1:8080/a.mp3"},
		{"loopback name", "http://127.0.0.1/a.mp3"},
		{"rfc1918 10", "https://10.0.0.5/a.mp3"},
		{"rfc1918 192.168", "https://192.168.0.17:8080/a.mp3"},
		{"rfc1918 172.16", "https://172.16.4.4/a.mp3"},
		{"tailnet cgnat", "https://100.64.0.1/a.mp3"},
		{"unspecified", "http://0.0.0.0/a.mp3"},
		{"ipv6 loopback", "http://[::1]/a.mp3"},
		{"ipv6 unique local", "http://[fd00::1]/a.mp3"},
		{"ipv6 link local", "http://[fe80::1]/a.mp3"},
		{"file scheme", "file:///etc/passwd"},
		{"gopher scheme", "gopher://127.0.0.1/"},
	}
	for _, tc := range blocked {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckURL(context.Background(), tc.url)
			if err == nil {
				t.Fatalf("CheckURL(%q) = nil, want blocked", tc.url)
			}
			var be *ErrBlocked
			if !errors.As(err, &be) {
				t.Fatalf("CheckURL(%q) = %v, want *ErrBlocked", tc.url, err)
			}
		})
	}
}

func TestCheckURLAllowsPublicLiteral(t *testing.T) {
	for _, u := range []string{
		"https://8.8.8.8/a.mp3",
		"http://1.1.1.1/a.mp3",
		"https://[2001:4860:4860::8888]/a.mp3",
	} {
		if err := CheckURL(context.Background(), u); err != nil {
			t.Errorf("CheckURL(%q) = %v, want nil", u, err)
		}
	}
}

func TestDialControlBlocksNonPublic(t *testing.T) {
	for _, addr := range []string{
		"169.254.169.254:80",
		"127.0.0.1:8080",
		"10.1.2.3:443",
		"100.64.0.1:443",
		"[::1]:80",
	} {
		if err := DialControl("tcp", addr, nil); err == nil {
			t.Errorf("DialControl(%q) = nil, want blocked", addr)
		}
	}
	if err := DialControl("tcp", "8.8.8.8:443", nil); err != nil {
		t.Errorf("DialControl(public) = %v, want nil", err)
	}
}

func TestErrBlockedMessageNamesTheAddress(t *testing.T) {
	err := CheckURL(context.Background(), "http://169.254.169.254/x.mp3")
	if !strings.Contains(err.Error(), "169.254.169.254") {
		t.Errorf("error %q does not name the address", err)
	}
}
