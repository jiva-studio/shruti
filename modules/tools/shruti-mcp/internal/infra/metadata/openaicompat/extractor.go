// Package openaicompatmeta extracts track metadata from a filename via an
// OpenAI-compatible upstream (OpenRouter by default). Date/author/location/
// title/references/language hints come back as JSON.
package openaicompatmeta

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/pipeline/openaicompat"
	metaport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/metadata"
)

//go:embed prompt.system.txt
var defaultSystemPrompt string

//go:embed prompt.user.txt
var defaultUserPrompt string

const ProviderName = "openai-compat"

type Extractor struct {
	Client       *openaicompat.Client
	Model        string
	MaxTokens    int
	SystemPrompt string
	UserPrompt   string
}

type Config struct {
	Endpoint   string
	APIKey     string
	Model      string
	MaxTokens  int
	PromptPath string
}

func New(cfg Config) (*Extractor, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compat extractor: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("openai-compat extractor: %w", err)
	}
	max := cfg.MaxTokens
	if max == 0 {
		max = 1024
	}
	sys, usr := defaultSystemPrompt, defaultUserPrompt
	if cfg.PromptPath != "" {
		raw, err := os.ReadFile(cfg.PromptPath)
		if err != nil {
			return nil, fmt.Errorf("read extractor prompt %s: %w", cfg.PromptPath, err)
		}
		sys, usr = splitPrompt(string(raw))
	}
	return &Extractor{
		Client:       cli,
		Model:        cfg.Model,
		MaxTokens:    max,
		SystemPrompt: sys,
		UserPrompt:   usr,
	}, nil
}

func (e *Extractor) Name() string { return ProviderName }

type rawResult struct {
	Date       *string  `json:"date"`
	Author     *string  `json:"author"`
	Location   *string  `json:"location"`
	Title      *string  `json:"title"`
	Languages  []string `json:"languages"`
	References []struct {
		Source string `json:"source"`
		Tokens string `json:"tokens"`
	} `json:"references"`
	KindTag *string `json:"kind_tag"`
}

func (e *Extractor) Extract(ctx context.Context, relPath string, sourceCodes []string) (track.Metadata, error) {
	basename := filepath.Base(relPath)
	user := e.UserPrompt
	user = strings.ReplaceAll(user, "__RELPATH__", relPath)
	user = strings.ReplaceAll(user, "__FILENAME__", basename)
	codesJSON, _ := json.Marshal(sourceCodes)
	user = strings.ReplaceAll(user, "__KNOWN_SOURCES__", string(codesJSON))

	var rr rawResult
	if _, err := e.Client.RunJSON(ctx, openaicompat.Call{
		Model:     e.Model,
		MaxTokens: e.MaxTokens,
		System:    e.SystemPrompt,
		User:      user,
	}, &rr); err != nil {
		return track.Metadata{}, fmt.Errorf("llm extract: %w", err)
	}

	spec := track.MetadataSpec{}
	if rr.Date != nil && *rr.Date != "" {
		if t, err := time.Parse("2006-01-02", *rr.Date); err == nil {
			spec.Date = &t
		}
	}
	if rr.Author != nil {
		spec.AuthorRaw = strings.TrimSpace(*rr.Author)
	}
	if rr.Location != nil {
		spec.LocationRaw = strings.TrimSpace(*rr.Location)
	}
	if rr.Title != nil && strings.TrimSpace(*rr.Title) != "" {
		spec.Title = strings.TrimSpace(*rr.Title)
	} else {
		spec.Title = fallbackTitle(basename)
		spec.TitleIsFallback = true
	}
	spec.Languages = rr.Languages
	if rr.KindTag != nil {
		spec.KindTag = strings.TrimSpace(*rr.KindTag)
	}
	for _, r := range rr.References {
		if r.Source == "" {
			continue
		}
		spec.References = append(spec.References, track.RefRaw{
			SourceCode: r.Source,
			Tokens:     r.Tokens,
		})
	}
	return track.NewMetadata(spec)
}

func fallbackTitle(filename string) string {
	t := strings.TrimSuffix(filename, ".mp3")
	t = strings.TrimSuffix(t, ".MP3")
	parts := strings.SplitN(t, " ", 2)
	if len(parts) == 2 && looksLikeDate(parts[0]) {
		t = parts[1]
	}
	return strings.TrimSpace(t)
}

func looksLikeDate(s string) bool {
	if len(s) >= 8 && allDigits(s[:8]) {
		return true
	}
	if len(s) == 10 && s[4] == '-' && s[7] == '-' {
		return true
	}
	return false
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func splitPrompt(s string) (system, user string) {
	const sep = "===USER==="
	idx := strings.Index(s, sep)
	if idx < 0 {
		return "", strings.TrimSpace(s)
	}
	return strings.TrimSpace(s[:idx]), strings.TrimSpace(s[idx+len(sep):])
}

var _ metaport.Extractor = (*Extractor)(nil)
