package config

import (
	"testing"
)

// TestLoadExample parses the shipped config.example.yaml with dummy secrets,
// verifying structure, secret resolution, and cross-references validate.
func TestLoadExample(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "dummy-tg")
	t.Setenv("VK_COMMUNITY_TOKEN", "dummy-vk")
	t.Setenv("FB_PAGE_TOKEN", "dummy-fb")

	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Catalog.Scheme == 0 {
		t.Fatal("scheme not parsed")
	}
	if len(cfg.Campaigns) == 0 || len(cfg.Targets) == 0 {
		t.Fatal("campaigns/targets empty")
	}
	for name, tgt := range cfg.Targets {
		if tgt.Token == "" {
			t.Fatalf("target %q token not resolved from env", name)
		}
	}
	t.Logf("loaded: scheme=%d regions=%d targets=%d campaigns=%d",
		cfg.Catalog.Scheme, len(cfg.Catalog.Regions), len(cfg.Targets), len(cfg.Campaigns))
}

// TestMissingSecretFails asserts a configured target with no env secret is a
// load error, not a silent skip.
func TestMissingSecretFails(t *testing.T) {
	// No env vars set → secret resolution must fail.
	if _, err := Load("../../config.example.yaml"); err == nil {
		t.Fatal("expected error when target secrets are unset")
	}
}
