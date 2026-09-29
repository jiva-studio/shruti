package config

import (
	"strings"
	"testing"
)

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("REDIS_URL", "redis://localhost:6379")
	t.Setenv("STORAGE_ZONE", "test-zone")
	t.Setenv("STORAGE_KEY", "test-key")
	t.Setenv("OUTPUT_PUBLIC_BASE", "https://cdn.example.test")
}

func TestLoadAcceptsBunnyCredentialsWithoutABucket(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("SHRUTI_S3_BUCKET", "")
	t.Setenv("BUCKET", "")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.StorageZone != "test-zone" || c.StorageKey != "test-key" || c.OutputPublicBase != "https://cdn.example.test" {
		t.Fatalf("got zone=%q key=%q base=%q", c.StorageZone, c.StorageKey, c.OutputPublicBase)
	}
}

func TestLoadRefusesWithoutBunnySetting(t *testing.T) {
	for _, missing := range []string{"STORAGE_ZONE", "STORAGE_KEY", "OUTPUT_PUBLIC_BASE"} {
		t.Run(missing, func(t *testing.T) {
			setRequiredEnv(t)
			t.Setenv("SHRUTI_S3_BUCKET", "test-bucket")
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
