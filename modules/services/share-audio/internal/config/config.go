// Package config loads environment-driven settings once at boot.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Env            string
	ServiceVersion string
	LogLevel       string
	Port           string

	ExcerptsPrefix string
	// ExcerptsPublicBase is the pull zone in front of the storage zone. Both
	// excerpt URLs and the source URL ffmpeg reads are composed from it.
	ExcerptsPublicBase string
	// SourceKeyPrefix gates POST /excerpts: requests with a source_key
	// outside this prefix are rejected before any read, so anonymous
	// callers cannot probe sibling prefixes (private/backups/…, etc.).
	SourceKeyPrefix string

	StorageZone     string
	StorageKey      string
	StorageEndpoint string

	FfmpegBin    string
	MaxExcerptMs int64
}

func Load() (Config, error) {
	c := Config{
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
		LogLevel:       env("LOG_LEVEL", "info"),
		Port:           env("PORT", "8082"),

		ExcerptsPrefix:     env("EXCERPTS_PREFIX", "public/shares/audio"),
		ExcerptsPublicBase: env("EXCERPTS_PUBLIC_BASE", ""),
		SourceKeyPrefix:    env("SOURCE_KEY_PREFIX", "public/tracks/"),

		StorageZone:     env("STORAGE_ZONE", ""),
		StorageKey:      env("STORAGE_KEY", ""),
		StorageEndpoint: env("STORAGE_ENDPOINT", ""),

		FfmpegBin:    env("FFMPEG_BIN", "/usr/bin/ffmpeg"),
		MaxExcerptMs: 10 * 60 * 1000,
	}
	for name, v := range map[string]string{
		"STORAGE_ZONE":         c.StorageZone,
		"STORAGE_KEY":          c.StorageKey,
		"EXCERPTS_PUBLIC_BASE": c.ExcerptsPublicBase,
	} {
		if v == "" {
			return c, fmt.Errorf("%s is required", name)
		}
	}
	return c, nil
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
