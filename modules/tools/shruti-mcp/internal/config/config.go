// Package config loads and validates the shruti-mcp configuration.
package config

import (
	"errors"
	"path/filepath"
)

// Config is the whole YAML file. Each section's type, defaults and helpers
// live beside it: storage.go (CDN and publish targets), media.go (ffmpeg,
// denoiser, transcription), review.go, models.go (the LLM, embedding and
// image endpoints) and topics.go.
type Config struct {
	In              string `yaml:"in"`
	Out             string `yaml:"out"`
	DB              string `yaml:"db"`
	RunsDB          string `yaml:"runs_db"`
	DefaultLanguage string `yaml:"default_language"`

	// Concurrency caps how many files may sit inside a stage at once, by stage
	// name (ingested, normalized, metadata, transcribed, reviewed, committed).
	// The worker pool is file-level, so without this one number has to serve
	// stages with opposite needs: transcribe waits on a remote box and wants
	// many workers in parallel, while normalize and commit contend for the
	// local disk, where concurrent access on a mechanical drive costs most of
	// the throughput. Absent or 0 = unrestricted.
	Concurrency map[string]int `yaml:"concurrency,omitempty"`

	CDN        CDN        `yaml:"cdn"`
	S3         S3         `yaml:"s3"`
	FFmpeg     FFmpeg     `yaml:"ffmpeg"`
	Denoiser   Denoiser   `yaml:"denoiser"`
	Transcribe Transcribe `yaml:"transcribe"`
	Review     Review     `yaml:"review"`
	Resolver   Resolver   `yaml:"resolver"`
	Metadata   Metadata   `yaml:"metadata"`
	Outline    Outline    `yaml:"outline"`
	Embed      Embed      `yaml:"embed"`
	Images     Images     `yaml:"images"`
	Topics     Topics     `yaml:"topics"`
}

func (c *Config) applyDefaults() {
	if c.DefaultLanguage == "" {
		c.DefaultLanguage = "ru"
	}
	if c.DB == "" && c.Out != "" {
		c.DB = filepath.Join(c.Out, "artifacts", "lake", "index.db")
	}
	if c.RunsDB == "" && c.Out != "" {
		c.RunsDB = filepath.Join(c.Out, "artifacts", "lake", "runs.db")
	}
	c.CDN.applyDefaults()
	c.S3.applyDefaults()
	c.Images.applyDefaults()
	c.Topics.applyDefaults()
	c.FFmpeg.applyDefaults()
	c.Denoiser.applyDefaults()
	c.Transcribe.applyDefaults()
	c.Review.applyDefaults()
	c.Resolver.applyDefaults()
	c.Metadata.applyDefaults()
}

func (c *Config) validate() error {
	if c.In == "" {
		return errors.New("config: 'in' is required")
	}
	if c.Out == "" {
		return errors.New("config: 'out' is required")
	}
	return nil
}
