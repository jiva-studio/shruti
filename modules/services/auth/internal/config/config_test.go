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

func TestLoadPromotesSingleWebhookSecret(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/auth")
	t.Setenv("ANON_QUOTA_PEPPER", "deployment-pepper")
	t.Setenv("RC_WEBHOOK_SECRET", "single")
	for _, tc := range []struct {
		name, primary, secondary, wantPrimary string
	}{
		{"single secret fills the primary slot", "", "", "single"},
		{"a primary slot wins", "rotated", "", "rotated"},
		{"a secondary slot alone keeps the primary empty", "", "next", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("RC_WEBHOOK_SECRET_PRIMARY", tc.primary)
			t.Setenv("RC_WEBHOOK_SECRET_SECONDARY", tc.secondary)
			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if cfg.RCWebhookSecretPrimary != tc.wantPrimary {
				t.Fatalf("primary = %q, want %q", cfg.RCWebhookSecretPrimary, tc.wantPrimary)
			}
			if cfg.RCWebhookSecretSecondary != tc.secondary {
				t.Fatalf("secondary = %q, want %q", cfg.RCWebhookSecretSecondary, tc.secondary)
			}
		})
	}
}
