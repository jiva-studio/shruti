package profile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadPolicy_Global(t *testing.T) {
	path := configPath(t)
	p, err := LoadPolicy(path, "global")
	if err != nil {
		t.Fatalf("LoadPolicy global: %v", err)
	}
	if !p.Email.Enabled {
		t.Error("global profile: expected email.enabled=true")
	}
	if p.Phone.Enabled {
		t.Error("global profile: expected phone.enabled=false")
	}
}

func TestLoadPolicy_RU(t *testing.T) {
	path := configPath(t)
	p, err := LoadPolicy(path, "ru")
	if err != nil {
		t.Fatalf("LoadPolicy ru: %v", err)
	}
	if p.Email.Enabled {
		t.Error("ru profile: expected email.enabled=false")
	}
	if !p.Locale.Enabled {
		t.Error("ru profile: expected locale.enabled=true")
	}
}

func TestLoadPolicy_UnknownProfile(t *testing.T) {
	path := configPath(t)
	_, err := LoadPolicy(path, "atlantis")
	if err == nil {
		t.Fatal("expected error for unknown profile")
	}
	if !strings.Contains(err.Error(), "unknown profile") {
		t.Errorf("expected 'unknown profile' in error, got: %v", err)
	}
}

func TestLoadPolicy_MissingFile(t *testing.T) {
	_, err := LoadPolicy("/nonexistent/file.yaml", "global")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

// configPath locates `modules/services/auth/config/config.yaml` starting
// from the test's working directory and walking up until it finds the
// auth-service root (the directory containing go.mod for this module).
// Falls back to the LECTORIUM_AUTH_CONFIG env var for CI / overrides.
func configPath(t *testing.T) string {
	t.Helper()
	if override := os.Getenv("LECTORIUM_AUTH_CONFIG"); override != "" {
		return override
	}
	dir, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("abs cwd: %v", err)
	}
	for i := 0; i < 10; i++ {
		// Auth service root has both go.mod and config/config.yaml.
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			candidate := filepath.Join(dir, "config", "config.yaml")
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatal("could not locate config/config.yaml relative to test directory")
	return ""
}
