package config

import (
	"testing"
	"time"
)

// TestLoad_SignedInTTLDefaults — verifies the dry-run safety default
// and the 24-month TTL default. A future operator who deploys without
// touching the env vars must NOT get a cron that immediately starts
// DELETING signed-in users.
func TestLoad_SignedInTTLDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://stub")
	t.Setenv("CLEANUP_SIGNED_IN_TTL", "")
	t.Setenv("CLEANUP_SIGNED_IN_INTERVAL", "")
	t.Setenv("CLEANUP_SIGNED_IN_DRY_RUN", "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.SignedInTTLDryRun {
		t.Errorf("SignedInTTLDryRun=%v want true (safety default)", cfg.SignedInTTLDryRun)
	}
	if cfg.SignedInTTL != 17520*time.Hour {
		t.Errorf("SignedInTTL=%v want 17520h", cfg.SignedInTTL)
	}
	if cfg.SignedInTTLInterval != 24*time.Hour {
		t.Errorf("SignedInTTLInterval=%v want 24h", cfg.SignedInTTLInterval)
	}
}

// TestLoad_SignedInTTLDryRunFalse — operator flip to enable real
// deletes after the observation window. Lenient bool parse accepts
// common spellings.
func TestLoad_SignedInTTLDryRunFalse(t *testing.T) {
	cases := []string{"false", "0", "no", "off", "FALSE", "False"}
	for _, v := range cases {
		t.Run(v, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://stub")
			t.Setenv("CLEANUP_SIGNED_IN_DRY_RUN", v)
			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if cfg.SignedInTTLDryRun {
				t.Errorf("SignedInTTLDryRun=true for %q, want false", v)
			}
		})
	}
}

// TestLoad_SignedInTTLZeroDisables — the same "TTL=0 disables" escape
// hatch as anon_cleanup.
func TestLoad_SignedInTTLZeroDisables(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://stub")
	t.Setenv("CLEANUP_SIGNED_IN_TTL", "0")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SignedInTTL != 0 {
		t.Errorf("SignedInTTL=%v want 0", cfg.SignedInTTL)
	}
}
