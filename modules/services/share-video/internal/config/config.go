// Package config loads share-video settings once at boot.
//
// Env-var names mirror the legacy TypeScript service so compose blocks
// can be dropped in unchanged. Transcription goes through an OpenAI-
// compatible endpoint (OpenRouter by default) — see TRANSCRIBE_* below.
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

	BackgroundsPrefix string
	OutputPrefix      string
	// OutputPublicBase is the pull zone in front of the storage zone; reel
	// URLs are composed from it.
	OutputPublicBase string

	StorageZone     string
	StorageKey      string
	StorageEndpoint string

	// Transcription (OpenAI-compatible /audio/transcriptions).
	TranscribeAPIKey  string
	TranscribeBaseURL string
	TranscribeModel   string

	JWTPublicKeyPath string

	AnonPerDay     int
	SignedInPerDay int

	FfmpegBin  string
	FfprobeBin string
	TempRoot   string

	// Local-mode overrides for running without the store (dev / smoke tests).
	// Each, when set, bypasses the store for that stage:
	//   LocalBackgroundsDir/<theme>/*.mp4 — background clips
	//   LocalSourceDir/<sourceKey>        — source audio
	//   LocalOutputDir/<...>.mp4          — finished reel (URL = file path)
	// All empty in production.
	LocalBackgroundsDir string
	LocalSourceDir      string
	LocalOutputDir      string

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

		BackgroundsPrefix: env("SHRUTI_S3_BACKGROUNDS_PREFIX", "private/share/video/backgrounds"),
		OutputPrefix:      env("SHRUTI_S3_VIDEO_PREFIX", "public/share/video"),
		OutputPublicBase:  env("OUTPUT_PUBLIC_BASE", ""),

		StorageZone:     env("STORAGE_ZONE", ""),
		StorageKey:      env("STORAGE_KEY", ""),
		StorageEndpoint: env("STORAGE_ENDPOINT", ""),

		TranscribeAPIKey:  os.Getenv("OPENROUTER_API_KEY"),
		TranscribeBaseURL: env("TRANSCRIBE_BASE_URL", "https://openrouter.ai/api/v1"),
		TranscribeModel:   env("TRANSCRIBE_MODEL", "openai/whisper-large-v3"),

		JWTPublicKeyPath: env("JWT_PUBLIC_KEY_PATH", "/secrets/public.pem"),

		AnonPerDay:     parseInt("SHARE_VIDEO_ANON_PER_DAY", 3),
		SignedInPerDay: parseInt("SHARE_VIDEO_SIGNED_IN_PER_DAY", 20),

		FfmpegBin:  env("FFMPEG_BIN", "/usr/bin/ffmpeg"),
		FfprobeBin: env("FFPROBE_BIN", "/usr/bin/ffprobe"),
		TempRoot:   env("TEMP_ROOT", "/tmp/render"),

		LocalBackgroundsDir: os.Getenv("LOCAL_BACKGROUNDS_DIR"),
		LocalSourceDir:      os.Getenv("LOCAL_SOURCE_DIR"),
		LocalOutputDir:      os.Getenv("LOCAL_OUTPUT_DIR"),

		SlideWidth:  720,
		SlideHeight: 1280,
		FontSize:    53,
	}
	for _, req := range []struct{ name, value string }{
		{"DATABASE_URL", c.DatabaseURL},
		{"REDIS_URL", c.RedisURL},
		{"STORAGE_ZONE", c.StorageZone},
		{"STORAGE_KEY", c.StorageKey},
		{"OUTPUT_PUBLIC_BASE", c.OutputPublicBase},
	} {
		if req.value == "" {
			return c, fmt.Errorf("%s is required", req.name)
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
