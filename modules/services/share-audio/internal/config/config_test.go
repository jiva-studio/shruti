package config

import (
	"strings"
	"testing"
)

func setBunnyEnv(t *testing.T) {
	t.Helper()
	t.Setenv("STORAGE_ZONE", "test-zone")
	t.Setenv("STORAGE_KEY", "test-key")
	t.Setenv("EXCERPTS_PUBLIC_BASE", "https://cdn.example.test")
}

func TestLoadAcceptsBunnyCredentials(t *testing.T) {
	setBunnyEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.StorageZone != "test-zone" || c.StorageKey != "test-key" || c.ExcerptsPublicBase != "https://cdn.example.test" {
		t.Fatalf("got zone=%q key=%q base=%q", c.StorageZone, c.StorageKey, c.ExcerptsPublicBase)
	}
}

func TestLoadRefusesWithoutBunnySetting(t *testing.T) {
	for _, missing := range []string{"STORAGE_ZONE", "STORAGE_KEY", "EXCERPTS_PUBLIC_BASE"} {
		t.Run(missing, func(t *testing.T) {
			setBunnyEnv(t)
			t.Setenv(missing, "")
			_, err := Load()
			if err == nil {
				t.Fatalf("Load succeeded with %s empty", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Fatalf("error should name %s, got %v", missing, err)
			}
		})
	}
}

func TestLoadRefusesAnS3OnlyConfig(t *testing.T) {
	t.Setenv("STORAGE_ZONE", "")
	t.Setenv("STORAGE_KEY", "")
	t.Setenv("BUCKET", "test-bucket")
	t.Setenv("S3_ENDPOINT_URL", "https://s3.example.test")
	t.Setenv("EXCERPTS_PUBLIC_BASE", "https://cdn.example.test")
	if _, err := Load(); err == nil {
		t.Fatal("Load started on S3 settings alone")
	}
}
