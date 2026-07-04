// Package config loads the YAML config (structure: catalog regions,
// publish targets, campaigns) once at boot. Secrets are never written in
// the YAML — each credential field names an env var (`*_env`) that Load
// resolves from the environment, so the file is safe to commit and the
// deploy only injects tokens.
package config

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the whole service configuration, parsed from one YAML file.
type Config struct {
	Service   Service            `yaml:"service"`
	Catalog   Catalog            `yaml:"catalog"`
	State     State              `yaml:"state"`
	Targets   map[string]*Target `yaml:"targets"`
	Campaigns []Campaign         `yaml:"campaigns"`
}

type Service struct {
	Env            string `yaml:"env"`
	ServiceVersion string `yaml:"version"`
	LogLevel       string `yaml:"log_level"`
	Port           string `yaml:"port"`
}

type Catalog struct {
	// Scheme is the supported catalog scheme (matches db-scheme.json). The
	// service downloads the newest DB with this scheme from the CDN.
	Scheme   int                     `yaml:"scheme"`
	CacheDir string                  `yaml:"cache_dir"`
	Refresh  string                  `yaml:"refresh"` // cron; how often to re-pull the DB
	Regions  map[string]RegionConfig `yaml:"regions"`
}

type RegionConfig struct {
	// CDNBase serves config.json + public/db/<app>.<version>.db and the
	// public poster/track assets.
	CDNBase string `yaml:"cdn_base"`
	// ShareAudioBase is the share-audio service base (…/share/audio).
	ShareAudioBase string `yaml:"share_audio_base"`
}

type State struct {
	DBPath string `yaml:"db_path"`
}

// Platform enumerates the publisher backends.
const (
	PlatformTelegram = "telegram"
	PlatformVK       = "vk"
	PlatformFacebook = "facebook"
)

// Target is one publish destination. A single struct carries every
// platform's fields; Validate enforces the per-platform required set.
type Target struct {
	Platform string `yaml:"platform"`

	// Telegram
	BotTokenEnv string `yaml:"bot_token_env"`
	ChatID      string `yaml:"chat_id"`

	// VK
	VKTokenEnv  string `yaml:"vk_token_env"`
	GroupID     string `yaml:"group_id"`
	AttachAudio bool   `yaml:"attach_audio"`

	// Facebook
	PageID       string `yaml:"page_id"`
	PageTokenEnv string `yaml:"page_token_env"`

	// Shared: how the poster image is produced for image platforms.
	Poster Poster `yaml:"poster"`

	// Token is the credential resolved from the platform's *_env var at
	// load time. Not read from YAML.
	Token string `yaml:"-"`
}

// Poster selects how the VK/Facebook poster image is produced.
type Poster struct {
	// Mode: prebuilt | brand_static | render | none.
	Mode string `yaml:"mode"`
	// Images is the pool of ready-made poster URLs on Bunny (prebuilt mode);
	// the bot picks one per post.
	Images []string `yaml:"images"`
	// Image is the single fixed image URL (brand_static mode).
	Image string `yaml:"image"`
	// Template is the background image URL text is drawn over (render mode,
	// not yet implemented).
	Template string `yaml:"template"`
}

// Campaign is one scheduled publish job with its dynamic filters.
type Campaign struct {
	Name     string   `yaml:"name"`
	Schedule string   `yaml:"schedule"` // cron
	Region   string   `yaml:"region"`
	Content  string   `yaml:"content"` // daily_wisdom | lecture
	Filters  Filters  `yaml:"filters"`
	Targets  []string `yaml:"targets"`
	Enabled  *bool    `yaml:"enabled"` // default true
}

// Filters is the dynamic-filter spec resolved by the selector. Every field
// is optional; the selector composes the ones that are set.
type Filters struct {
	Language      string `yaml:"language"`
	Day           string `yaml:"day"`   // "" | on_this_day
	Order         string `yaml:"order"` // random | topic_weight | recent
	Pick          string `yaml:"pick"`  // random | top1
	Topic         string `yaml:"topic"` // topic id, optional
	NotPostedDays int    `yaml:"not_posted_days"`
	// ExcerptMs bounds the audio excerpt for lecture content (from the
	// track start). Ignored for daily_wisdom, which carries its own
	// start/end. 0 → selector default.
	ExcerptMs int64 `yaml:"excerpt_ms"`
}

const (
	ContentDailyWisdom = "daily_wisdom"
	ContentLecture     = "lecture"
)

// Load reads, parses, resolves secrets, applies defaults, and validates.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %q: %w", path, err)
	}
	var c Config
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse config %q: %w", path, err)
	}
	c.applyDefaults()
	if err := c.resolveSecrets(); err != nil {
		return nil, err
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	if c.Service.Env == "" {
		c.Service.Env = "dev"
	}
	if c.Service.ServiceVersion == "" {
		c.Service.ServiceVersion = "dev"
	}
	if c.Service.LogLevel == "" {
		c.Service.LogLevel = "info"
	}
	if c.Service.Port == "" {
		c.Service.Port = "8090"
	}
	if c.Catalog.CacheDir == "" {
		c.Catalog.CacheDir = "/var/lib/social-poster/catalog"
	}
	if c.Catalog.Refresh == "" {
		c.Catalog.Refresh = "0 */6 * * *"
	}
	if c.State.DBPath == "" {
		c.State.DBPath = "/var/lib/social-poster/state.db"
	}
	for _, t := range c.Targets {
		if t.Poster.Mode == "" {
			t.Poster.Mode = "none"
		}
	}
}

// resolveSecrets pulls each target's credential from the env var it names.
// A configured target with a missing secret is a boot failure, not a
// silent no-op — a half-authenticated deploy would drop posts quietly.
func (c *Config) resolveSecrets() error {
	for name, t := range c.Targets {
		var envKey string
		switch t.Platform {
		case PlatformTelegram:
			envKey = t.BotTokenEnv
		case PlatformVK:
			envKey = t.VKTokenEnv
		case PlatformFacebook:
			envKey = t.PageTokenEnv
		default:
			return fmt.Errorf("target %q: unknown platform %q", name, t.Platform)
		}
		if envKey == "" {
			return fmt.Errorf("target %q (%s): missing the *_env credential field", name, t.Platform)
		}
		tok := strings.TrimSpace(os.Getenv(envKey))
		if tok == "" {
			return fmt.Errorf("target %q (%s): env %s is empty", name, t.Platform, envKey)
		}
		t.Token = tok
	}
	return nil
}

func (c *Config) Validate() error {
	if c.Catalog.Scheme == 0 {
		return fmt.Errorf("catalog.scheme is required")
	}
	if len(c.Catalog.Regions) == 0 {
		return fmt.Errorf("catalog.regions must have at least one region")
	}
	for name, r := range c.Catalog.Regions {
		if r.CDNBase == "" {
			return fmt.Errorf("region %q: cdn_base is required", name)
		}
	}
	for name, t := range c.Targets {
		if err := t.validate(name); err != nil {
			return err
		}
	}
	if len(c.Campaigns) == 0 {
		return fmt.Errorf("no campaigns configured")
	}
	seen := map[string]bool{}
	for _, cp := range c.Campaigns {
		if cp.Name == "" {
			return fmt.Errorf("campaign with empty name")
		}
		if seen[cp.Name] {
			return fmt.Errorf("duplicate campaign name %q", cp.Name)
		}
		seen[cp.Name] = true
		if cp.Schedule == "" {
			return fmt.Errorf("campaign %q: schedule is required", cp.Name)
		}
		if cp.Content != ContentDailyWisdom && cp.Content != ContentLecture {
			return fmt.Errorf("campaign %q: content must be %q or %q", cp.Name, ContentDailyWisdom, ContentLecture)
		}
		if _, ok := c.Catalog.Regions[cp.Region]; !ok {
			return fmt.Errorf("campaign %q: unknown region %q", cp.Name, cp.Region)
		}
		if len(cp.Targets) == 0 {
			return fmt.Errorf("campaign %q: no targets", cp.Name)
		}
		for _, tn := range cp.Targets {
			if _, ok := c.Targets[tn]; !ok {
				return fmt.Errorf("campaign %q: unknown target %q", cp.Name, tn)
			}
		}
	}
	return nil
}

func (t *Target) validate(name string) error {
	switch t.Platform {
	case PlatformTelegram:
		if t.ChatID == "" {
			return fmt.Errorf("target %q (telegram): chat_id is required", name)
		}
	case PlatformVK:
		if t.GroupID == "" {
			return fmt.Errorf("target %q (vk): group_id is required", name)
		}
	case PlatformFacebook:
		if t.PageID == "" {
			return fmt.Errorf("target %q (facebook): page_id is required", name)
		}
	default:
		return fmt.Errorf("target %q: unknown platform %q", name, t.Platform)
	}
	return nil
}

// IsEnabled reports whether a campaign should be scheduled (default true).
func (cp Campaign) IsEnabled() bool { return cp.Enabled == nil || *cp.Enabled }
