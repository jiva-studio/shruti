package config

import (
	"strings"
	"testing"
)

func TestLoadRequiresAnonQuotaPepper(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/auth")
	t.Setenv("ANON_QUOTA_PEPPER", "")

	cfg, err := Load()
	if err == nil {
		t.Fatalf("Load without ANON_QUOTA_PEPPER succeeded with pepper %q, want an error", cfg.AnonQuotaPepper)
	}
	if !strings.Contains(err.Error(), "ANON_QUOTA_PEPPER") {
		t.Fatalf("error %q does not name ANON_QUOTA_PEPPER", err)
	}
}

func TestLoadTakesAnonQuotaPepper(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/auth")
	t.Setenv("ANON_QUOTA_PEPPER", "deployment-pepper")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AnonQuotaPepper != "deployment-pepper" {
		t.Fatalf("AnonQuotaPepper = %q, want deployment-pepper", cfg.AnonQuotaPepper)
	}
}
