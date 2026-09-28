package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Load reads YAML config from path, expands ${ENV_VAR} and ~, applies defaults.
//
// Before parsing, Load looks for a `.env` file alongside the YAML and in the
// current working directory and loads any `KEY=VALUE` lines into the process
// env. Existing process env wins (so secrets in env override file values).
// This keeps S3 credentials project-local — no home-dir lookups.
func Load(path string) (*Config, error) {
	if err := loadDotEnvNear(path); err != nil {
		return nil, err
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	expanded := expandEnv(string(raw))

	var c Config
	if err := yaml.Unmarshal([]byte(expanded), &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	c.In = expandTilde(c.In)
	c.Out = expandTilde(c.Out)
	c.DB = expandTilde(c.DB)
	c.RunsDB = expandTilde(c.RunsDB)
	for name, p := range c.Transcribe.Providers {
		p.Model = expandTilde(p.Model)
		c.Transcribe.Providers[name] = p
	}

	c.applyDefaults()

	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

var envPattern = regexp.MustCompile(`\$\{([A-Z_][A-Z0-9_]*)\}`)

func expandEnv(s string) string {
	return envPattern.ReplaceAllStringFunc(s, func(match string) string {
		name := match[2 : len(match)-1]
		return os.Getenv(name)
	})
}

func expandTilde(p string) string {
	if p == "" || !strings.HasPrefix(p, "~") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}
