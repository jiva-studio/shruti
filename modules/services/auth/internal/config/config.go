// Package config loads runtime configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Port              string
	DatabaseURL       string
	JWTPrivateKeyPath string
	JWTPublicKeyPath  string
	// JWTPublicKeysDir, if set, opts the verifier into multi-key /
	// kid-aware mode: every `<kid>.pub.pem` in the directory is
	// loaded, plus the legacy `public.pem` mapped to kid "v1".
	// Leave unset to stay on the single-file path.
	JWTPublicKeysDir string
	JWTKid           string
	GoogleClientIDs  []string
	AppleBundleIDs   []string
	// RCWebhookSecretPrimary / RCWebhookSecretSecondary are the Bearer
	// values RevenueCat sends in the Authorization header of every webhook
	// delivery (configured in the RC dashboard → Project → Webhooks). Two
	// slots are accepted so secrets can be rotated without dropping
	// deliveries — see runbooks/rc-webhook-secret-rotation.md. Both slots
	// empty disables the webhook endpoint entirely.
	//
	// Legacy `RC_WEBHOOK_SECRET` (single-secret deployments pre-rotation)
	// is still honoured: if neither PRIMARY nor SECONDARY is set, the
	// legacy value populates PRIMARY at boot.
	RCWebhookSecretPrimary   string
	RCWebhookSecretSecondary string
	// RCRestAPIKey is the RC project's public-side API key used to
	// call `GET /v1/subscribers/{app_user_id}` after a webhook fires.
	// We do this REST refetch instead of trusting webhook payload
	// fields — RC themselves recommend it (covers out-of-order delivery,
	// refund/grace semantics, etc).
	RCRestAPIKey string
	// Env tags log lines for Datadog tag-from-log pipelines.
	// "dev" | "staging" | "prod". Defaults to "dev".
	Env string
	// ServiceVersion is the image tag at runtime (SHRUTI_AUTH_TAG in
	// compose). Surfaces in every log line as `version`.
	ServiceVersion string
	// ConfigPath points at the structured YAML config (currently consumed
	// only by the profile-collection policy loader; future structured
	// knobs land in the same file).
	ConfigPath string
	// Profile selects which `profile_collection.profiles.<name>` block
	// from ConfigPath governs optional profile-field collection. Default
	// "global"; "ru" minimises stored fields for the Russia deployment.
	Profile string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:              env("PORT", "8081"),
		DatabaseURL:       env("DATABASE_URL", ""),
		JWTPrivateKeyPath: env("JWT_PRIVATE_KEY_PATH", "/secrets/private.pem"),
		JWTPublicKeyPath:  env("JWT_PUBLIC_KEY_PATH", "/secrets/public.pem"),
		JWTPublicKeysDir:  os.Getenv("JWT_PUBLIC_KEYS_DIR"),
		JWTKid:            env("JWT_KID", "v1"),
		GoogleClientIDs:   splitCSV(os.Getenv("GOOGLE_CLIENT_IDS")),
		AppleBundleIDs:    splitCSV(os.Getenv("APPLE_BUNDLE_IDS")),
		RCWebhookSecretPrimary:   os.Getenv("RC_WEBHOOK_SECRET_PRIMARY"),
		RCWebhookSecretSecondary: os.Getenv("RC_WEBHOOK_SECRET_SECONDARY"),
		RCRestAPIKey:             os.Getenv("RC_REST_API_KEY"),
		Env:               env("ENV", "dev"),
		ServiceVersion:    env("SERVICE_VERSION", "dev"),
		ConfigPath:        env("CONFIG_PATH", "/etc/shruti/auth/config.yaml"),
		Profile:           env("PROFILE", "global"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	// Legacy single-secret deployments: promote RC_WEBHOOK_SECRET into the
	// primary slot when neither rotation slot is wired. Anything that sets
	// PRIMARY/SECONDARY wins — the new envs are the source of truth once
	// rotation has happened.
	if cfg.RCWebhookSecretPrimary == "" && cfg.RCWebhookSecretSecondary == "" {
		cfg.RCWebhookSecretPrimary = os.Getenv("RC_WEBHOOK_SECRET")
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
