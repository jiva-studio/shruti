// Package config loads runtime configuration from environment variables.
//
// The service must boot even when the Paymento / internal-grant secrets are
// unset — endpoints that need a missing secret return 503 at request time
// (mirrors how auth tolerates missing RevenueCat creds). Only DATABASE_URL is
// strictly required at boot.
package config

import (
	"fmt"
	"os"
)

type Config struct {
	Port             string
	DatabaseURL      string
	JWTPublicKeyPath string

	PaymentoAPIKey     string
	PaymentoHMACSecret string
	PaymentoBaseURL    string

	AuthInternalURL  string
	InternalAPIToken string

	PublicBaseURL string

	Env            string
	ServiceVersion string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:             env("PORT", "8082"),
		DatabaseURL:      env("DATABASE_URL", ""),
		JWTPublicKeyPath: env("JWT_PUBLIC_KEY_PATH", "/secrets/public.pem"),

		PaymentoAPIKey:     os.Getenv("PAYMENTO_API_KEY"),
		PaymentoHMACSecret: os.Getenv("PAYMENTO_HMAC_SECRET"),
		PaymentoBaseURL:    env("PAYMENTO_BASE_URL", "https://api.paymento.io"),

		AuthInternalURL:  env("AUTH_INTERNAL_URL", "http://auth:8081"),
		InternalAPIToken: os.Getenv("INTERNAL_API_TOKEN"),

		PublicBaseURL: env("PUBLIC_BASE_URL", "https://shruti.app"),

		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
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
