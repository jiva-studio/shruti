// Package openaicompattitle generates a clean track title via an
// OpenAI-compatible upstream (OpenRouter by default). Returns one short
// English title — see prompt.system.txt for output rules.
package openaicompattitle

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	titleport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/title"
	"github.com/jiva-studio/lectorium/pipeline/openaicompat"
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
	Endpoint  string
	APIKey    string
	Model     string
	MaxTokens int
}

func New(cfg Config) (*Extractor, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compat title extractor: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("openai-compat title extractor: %w", err)
	}
	maxTokens := cfg.MaxTokens
	if maxTokens == 0 {
		maxTokens = 64
	}
	return &Extractor{
		Client:       cli,
		Model:        cfg.Model,
		MaxTokens:    maxTokens,
		SystemPrompt: defaultSystemPrompt,
		UserPrompt:   defaultUserPrompt,
	}, nil
}

func (e *Extractor) Name() string { return ProviderName }

func (e *Extractor) Extract(ctx context.Context, in titleport.Input) (string, error) {
	lang := strings.TrimSpace(in.Language)
	if lang == "" {
		lang = "en"
	}
	sys := strings.ReplaceAll(e.SystemPrompt, "__LANG__", lang)

	user := e.UserPrompt
	user = strings.ReplaceAll(user, "__KIND__", noneIfEmpty(in.Kind))
	user = strings.ReplaceAll(user, "__REFERENCES__", noneIfEmpty(in.References))
	user = strings.ReplaceAll(user, "__LOCATION__", noneIfEmpty(in.Location))
	user = strings.ReplaceAll(user, "__DATE__", noneIfEmpty(in.Date))
	user = strings.ReplaceAll(user, "__HEADER_HINT__", noneIfEmpty(in.HeaderHint))
	user = strings.ReplaceAll(user, "__TRANSCRIPT__", noneIfEmpty(in.Transcript))

	res, err := e.Client.Run(ctx, openaicompat.Call{
		Model:     e.Model,
		MaxTokens: e.MaxTokens,
		System:    sys,
		User:      user,
	})
	if err != nil {
		return "", fmt.Errorf("title llm: %w", err)
	}
	return cleanTitle(res.Text), nil
}

// cleanTitle strips markdown fences, surrounding quotes, leading "Title:"
// preambles, and trailing punctuation that the model occasionally emits
// despite the prompt rules.
func cleanTitle(s string) string {
	s = openaicompat.StripFences(s)
	s = strings.TrimSpace(s)
	// Drop leading "Title:" / "TITLE -" preambles.
	for _, prefix := range []string{"Title:", "TITLE:", "title:", "Title -", "Title —"} {
		if strings.HasPrefix(s, prefix) {
			s = strings.TrimSpace(s[len(prefix):])
		}
	}
	// Take only the first non-empty line — ignores any model commentary
	// that follows.
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	// Strip surrounding quotes (any flavor).
	s = strings.Trim(s, "\"'`“”‘’«»")
	s = strings.TrimSpace(s)
	// Strip trailing period / colon — they shouldn't appear in titles.
	s = strings.TrimRight(s, ".:;")
	return strings.TrimSpace(s)
}

func noneIfEmpty(s string) string {
	if strings.TrimSpace(s) == "" {
		return "none"
	}
	return s
}

var _ titleport.Extractor = (*Extractor)(nil)
