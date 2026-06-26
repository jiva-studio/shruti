// Package config loads environment-driven settings once at boot.
//
// Env-var names mirror the legacy Python service so that compose blocks
// can be reused unchanged during the cutover from FastAPI to Go.
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

	Bucket             string
	ExcerptsPrefix     string
	ExcerptsPublicBase string
	// SourceKeyPrefix gates POST /excerpts: requests with a source_key
	// outside this prefix are rejected before any S3 GET. Defense in
	// depth on top of the bucket-level IAM role (D1) — protects
	// against IAM drift and stops anonymous probing of sibling
	// prefixes (private/backups/…, etc.).
	SourceKeyPrefix string

	AWSRegion     string
	S3EndpointURL string

	FfmpegBin    string
	MaxExcerptMs int64
}

func Load() (Config, error) {
	c := Config{
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
		LogLevel:       env("LOG_LEVEL", "info"),
		Port:           env("PORT", "8082"),

		Bucket:             firstNonEmpty(os.Getenv("BUCKET"), os.Getenv("LECTORIUM_S3_BUCKET")),
		ExcerptsPrefix:     env("EXCERPTS_PREFIX", "public/shares/audio"),
		ExcerptsPublicBase: os.Getenv("EXCERPTS_PUBLIC_BASE"),
		SourceKeyPrefix:    env("SOURCE_KEY_PREFIX", "public/tracks/"),

		AWSRegion:     env("AWS_REGION", "us-east-1"),
		S3EndpointURL: os.Getenv("S3_ENDPOINT_URL"),

		FfmpegBin:    env("FFMPEG_BIN", "/usr/bin/ffmpeg"),
		MaxExcerptMs: 10 * 60 * 1000,
	}
	if c.Bucket == "" {
		return c, fmt.Errorf("BUCKET (or LECTORIUM_S3_BUCKET) is required")
	}
	// A non-AWS endpoint (RU → Yandex) MUST come with a matching public
	// base, or BuildURL falls back to the AWS virtual-hosted form for
	// objects that live on the alternate endpoint and clients get a dead
	// URL. Fail loudly rather than silently emit wrong URLs.
	if c.S3EndpointURL != "" && c.ExcerptsPublicBase == "" {
		return c, fmt.Errorf("EXCERPTS_PUBLIC_BASE is required when S3_ENDPOINT_URL is set, otherwise URLs point at AWS for objects on non-AWS storage")
	}
	return c, nil
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
