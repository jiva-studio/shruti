// Package config loads share-video settings once at boot.
//
// Env-var names mirror the legacy TypeScript service so compose blocks
// can be dropped in unchanged. The transcriber dispatch reads the same
// TRANSCRIBER env (whisper | speechkit) used by the Node version.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Env            string
	ServiceVersion string
	LogLevel       string
	Port           string

	DatabaseURL string
	RedisURL    string

	Bucket            string
	BackgroundsPrefix string
	OutputPrefix      string
	OutputPublicBase  string
	TranscribeScratch string
	AWSRegion         string
	S3EndpointURL     string

	// OutputBackend selects where the finished reel is written: "s3" (default,
	// AWS/Yandex) or "bunny". Reads + SpeechKit always stay on S3 (Bunny has no
	// presigning), so only the client-facing reel output flips.
	OutputBackend   string
	StorageZone     string
	StorageKey      string
	StorageEndpoint string

	OpenAIAPIKey    string
	SpeechKitAPIKey string
	Transcriber     string

	JWTPublicKeyPath string

	AnonPerDay     int
	SignedInPerDay int

	FfmpegBin  string
	FfprobeBin string
	TempRoot   string

	// Static rendering knobs that match ReelGenerator defaults.
	SlideWidth  int
	SlideHeight int
	FontSize    int
}

func Load() (Config, error) {
	c := Config{
		Env:            env("ENV", "dev"),
		ServiceVersion: env("SERVICE_VERSION", "dev"),
		LogLevel:       env("LOG_LEVEL", "info"),
		Port:           env("PORT", "8083"),

		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    os.Getenv("REDIS_URL"),

		Bucket:            firstNonEmpty(os.Getenv("SHRUTI_S3_BUCKET"), os.Getenv("BUCKET")),
		BackgroundsPrefix: env("SHRUTI_S3_BACKGROUNDS_PREFIX", "private/share/video/backgrounds"),
		OutputPrefix:      env("SHRUTI_S3_VIDEO_PREFIX", "public/share/video"),
		OutputPublicBase:  os.Getenv("OUTPUT_PUBLIC_BASE"),
		TranscribeScratch: env("TRANSCRIBE_SCRATCH_PREFIX", "private/share/video/transcribe-scratch"),
		AWSRegion:         env("AWS_REGION", "us-east-1"),
		S3EndpointURL:     os.Getenv("S3_ENDPOINT_URL"),

		OutputBackend:   strings.ToLower(env("STORAGE_BACKEND", "s3")),
		StorageZone:     os.Getenv("STORAGE_ZONE"),
		StorageKey:      os.Getenv("STORAGE_KEY"),
		StorageEndpoint: os.Getenv("STORAGE_ENDPOINT"),

		OpenAIAPIKey:    os.Getenv("OPENAI_API_KEY"),
		SpeechKitAPIKey: os.Getenv("SPEECHKIT_API_KEY"),
		Transcriber:     strings.ToLower(env("TRANSCRIBER", "whisper")),

		JWTPublicKeyPath: env("JWT_PUBLIC_KEY_PATH", "/secrets/public.pem"),

		AnonPerDay:     parseInt("SHARE_VIDEO_ANON_PER_DAY", 3),
		SignedInPerDay: parseInt("SHARE_VIDEO_SIGNED_IN_PER_DAY", 20),

		FfmpegBin:  env("FFMPEG_BIN", "/usr/bin/ffmpeg"),
		FfprobeBin: env("FFPROBE_BIN", "/usr/bin/ffprobe"),
		TempRoot:   env("TEMP_ROOT", "/tmp/render"),

		SlideWidth:  720,
		SlideHeight: 1280,
		FontSize:    53,
	}
	if c.Bucket == "" {
		return c, fmt.Errorf("SHRUTI_S3_BUCKET (or BUCKET) is required")
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	if c.RedisURL == "" {
		return c, fmt.Errorf("REDIS_URL is required")
	}
	// A non-AWS endpoint (RU → Yandex) MUST come with a matching public
	// base, or the URL builder falls back to the AWS virtual-hosted form
	// for objects that live on the alternate endpoint and clients get a
	// dead URL. Fail loudly rather than silently emit wrong URLs.
	if c.S3EndpointURL != "" && c.OutputPublicBase == "" {
		return c, fmt.Errorf("OUTPUT_PUBLIC_BASE is required when S3_ENDPOINT_URL is set, otherwise URLs point at AWS for objects on non-AWS storage")
	}
	switch c.OutputBackend {
	case "bunny":
		if c.StorageZone == "" || c.StorageKey == "" {
			return c, fmt.Errorf("STORAGE_ZONE and STORAGE_KEY are required when STORAGE_BACKEND=bunny")
		}
		if c.OutputPublicBase == "" {
			return c, fmt.Errorf("OUTPUT_PUBLIC_BASE is required when STORAGE_BACKEND=bunny")
		}
	case "s3", "":
		c.OutputBackend = "s3"
	default:
		return c, fmt.Errorf("STORAGE_BACKEND must be 's3' or 'bunny' (got %q)", c.OutputBackend)
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

func parseInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
