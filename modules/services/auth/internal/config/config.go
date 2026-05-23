// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Port               string
	DatabaseURL        string
	JWTPrivateKeyPath  string
	JWTPublicKeyPath   string
	JWTKid             string
	GoogleClientIDs    []string
	AppleBundleIDs     []string
	// Env tags log lines for Datadog tag-from-log pipelines.
	// "dev" | "staging" | "prod". Defaults to "dev".
	Env string
	// ServiceVersion is the image tag at runtime (SHRUTI_AUTH_TAG in
	// compose). Surfaces in every log line as `version`.
	ServiceVersion string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:              env("PORT", "8081"),
		DatabaseURL:       env("DATABASE_URL", ""),
		JWTPrivateKeyPath: env("JWT_PRIVATE_KEY_PATH", "/secrets/private.pem"),
		JWTPublicKeyPath:  env("JWT_PUBLIC_KEY_PATH", "/secrets/public.pem"),
		JWTKid:            env("JWT_KID", "v1"),
		GoogleClientIDs:   splitCSV(os.Getenv("GOOGLE_CLIENT_IDS")),
		AppleBundleIDs:    splitCSV(os.Getenv("APPLE_BUNDLE_IDS")),
		Env:               env("ENV", "dev"),
		ServiceVersion:    env("SERVICE_VERSION", "dev"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	return cfg, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
