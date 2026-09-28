package config

import (
	"slices"
	"testing"
	"time"
)

func setRequired(t *testing.T) {
	t.Helper()
	t.Setenv("STORAGE_ZONE", "zone")
	t.Setenv("STORAGE_KEY", "key")
	t.Setenv("YANDEX_BUCKET", "bucket")
	t.Setenv("YANDEX_ACCESS_KEY_ID", "id")
	t.Setenv("YANDEX_SECRET_ACCESS_KEY", "secret")
}

func TestLoadDefaultsPreserveMirroringScope(t *testing.T) {
	setRequired(t)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(c.ExcludePrefixes) != 0 {
		t.Fatalf("ExcludePrefixes = %v, want none by default", c.ExcludePrefixes)
	}
	if c.DeepInterval != 24*time.Hour {
		t.Fatalf("DeepInterval = %s, want 24h", c.DeepInterval)
	}
	want := []string{"public/config.json", "public/db/pending.db"}
	if !slices.Equal(c.MutableKeys, want) {
		t.Fatalf("MutableKeys = %v, want %v", c.MutableKeys, want)
	}
}

func TestLoadReadsComparisonPolicy(t *testing.T) {
	setRequired(t)
	t.Setenv("SYNC_DEEP_INTERVAL", "0")
	t.Setenv("SYNC_MUTABLE_KEYS", " public/config.json , public/tracks/*/transcripts/*.json ,")
	t.Setenv("SYNC_EXCLUDE_PREFIXES", "private/,tmp/")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.DeepInterval != 0 {
		t.Fatalf("DeepInterval = %s, want 0", c.DeepInterval)
	}
	if want := []string{"public/config.json", "public/tracks/*/transcripts/*.json"}; !slices.Equal(c.MutableKeys, want) {
		t.Fatalf("MutableKeys = %v, want %v", c.MutableKeys, want)
	}
	if want := []string{"private/", "tmp/"}; !slices.Equal(c.ExcludePrefixes, want) {
		t.Fatalf("ExcludePrefixes = %v, want %v", c.ExcludePrefixes, want)
	}
}

func TestLoadRefusesMalformedMutablePattern(t *testing.T) {
	setRequired(t)
	t.Setenv("SYNC_MUTABLE_KEYS", "public/[config.json")
	if _, err := Load(); err == nil {
		t.Fatal("a malformed pattern must fail config load")
	}
}

func TestLoadRefusesLeadingSlash(t *testing.T) {
	for _, env := range []string{"SYNC_MUTABLE_KEYS", "SYNC_EXCLUDE_PREFIXES"} {
		t.Run(env, func(t *testing.T) {
			setRequired(t)
			t.Setenv(env, "public/ok.json,/private/")
			if _, err := Load(); err == nil {
				t.Fatalf("%s with a leading slash must fail config load", env)
			}
		})
	}
}

func TestLoadRefusesNegativeDeepInterval(t *testing.T) {
	setRequired(t)
	t.Setenv("SYNC_DEEP_INTERVAL", "-5")
	if _, err := Load(); err == nil {
		t.Fatal("a negative deep interval must fail config load")
	}
}
