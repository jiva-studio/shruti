package config

import (
	"reflect"
	"testing"
)

func TestParseRemoteRegions(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []RemoteRegion
	}{
		{
			name: "empty",
			in:   "",
			want: nil,
		},
		{
			name: "single",
			in:   "russia=https://auth.russia.lectorium.app",
			want: []RemoteRegion{
				{ID: "russia", BaseURL: "https://auth.russia.lectorium.app"},
			},
		},
		{
			name: "multiple",
			in:   "russia=https://auth.russia.lectorium.app,asia=https://auth.asia.lectorium.app",
			want: []RemoteRegion{
				{ID: "russia", BaseURL: "https://auth.russia.lectorium.app"},
				{ID: "asia", BaseURL: "https://auth.asia.lectorium.app"},
			},
		},
		{
			name: "trims whitespace around items and around id/url",
			in:   "  russia  =  https://auth.russia.lectorium.app , asia=https://auth.asia.lectorium.app  ",
			want: []RemoteRegion{
				{ID: "russia", BaseURL: "https://auth.russia.lectorium.app"},
				{ID: "asia", BaseURL: "https://auth.asia.lectorium.app"},
			},
		},
		{
			name: "skips malformed entries (no '=')",
			in:   "russia=https://example,broken-no-equals,asia=https://example2",
			want: []RemoteRegion{
				{ID: "russia", BaseURL: "https://example"},
				{ID: "asia", BaseURL: "https://example2"},
			},
		},
		{
			name: "trailing comma is tolerated",
			in:   "russia=https://example,",
			want: []RemoteRegion{
				{ID: "russia", BaseURL: "https://example"},
			},
		},
		{
			name: "empty id or url skipped",
			in:   "=https://nothing,russia=,asia=https://ok",
			want: []RemoteRegion{
				{ID: "asia", BaseURL: "https://ok"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseRemoteRegions(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseRemoteRegions(%q):\n got: %+v\nwant: %+v", tc.in, got, tc.want)
			}
		})
	}
}

// TestLoad_FailsWhenRemoteRegionsSetWithoutSecret — half-configured
// cross-region delivery (REMOTE_REGIONS without LECTORIUM_INTERNAL_
// SECRET) would 401 at every destination. Fail boot loudly so the
// operator notices the missing secret instead of silently retrying.
func TestLoad_FailsWhenRemoteRegionsSetWithoutSecret(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://stub")
	t.Setenv("REMOTE_REGIONS", "russia=https://example")
	t.Setenv("LECTORIUM_INTERNAL_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected Load to fail when REMOTE_REGIONS set without LECTORIUM_INTERNAL_SECRET")
	}
}

// TestLoad_SecretWithoutRemotesIsHarmless — the secret can be set
// without remotes (handler still no-ops). Common during phased
// rollouts where the secret is provisioned before Russia DNS flips.
func TestLoad_SecretWithoutRemotesIsHarmless(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://stub")
	t.Setenv("LECTORIUM_INTERNAL_SECRET", "shared-secret")
	t.Setenv("REMOTE_REGIONS", "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.InternalSecret != "shared-secret" {
		t.Errorf("InternalSecret=%q want %q", cfg.InternalSecret, "shared-secret")
	}
	if len(cfg.RemoteRegions) != 0 {
		t.Errorf("RemoteRegions=%v want empty", cfg.RemoteRegions)
	}
}

// TestLoad_BothEmptyIsHarmless — single-region deployment (Cloud Provider
// today). Both envs unset must not fail boot; the broadcast handler
// degrades to no-op.
func TestLoad_BothEmptyIsHarmless(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://stub")
	t.Setenv("LECTORIUM_INTERNAL_SECRET", "")
	t.Setenv("REMOTE_REGIONS", "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.InternalSecret != "" {
		t.Errorf("InternalSecret=%q want empty", cfg.InternalSecret)
	}
	if len(cfg.RemoteRegions) != 0 {
		t.Errorf("RemoteRegions=%v want empty", cfg.RemoteRegions)
	}
}
