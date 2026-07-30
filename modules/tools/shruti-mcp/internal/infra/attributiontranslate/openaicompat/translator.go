// Package openaicompatattribtranslate implements libraryport.AttributionTranslator
// against an OpenAI-compatible upstream (OpenRouter). One LLM call per target
// language at attribution-create time; failures are non-fatal for the caller.
package openaicompatattribtranslate

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
	"github.com/jiva-studio/shruti/pipeline/openaicompat"
	libraryport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/library"
)

//go:embed prompt.pinned.txt
var pinnedPrompt string

//go:embed prompt.boost.txt
var boostPrompt string

//go:embed prompt.memory.txt
var memoryPrompt string

// memoryMaxTokens is the floor for translating a memory note — notes are long
// (multi-paragraph) so the per-attribution default (≈200) would truncate them.
const memoryMaxTokens = 4000

const ProviderName = "openai-compat-attribution"

type Translator struct {
	Client    *openaicompat.Client
	Model     string
	MaxTokens int
}

type Config struct {
	Endpoint  string
	APIKey    string
	Model     string // openrouter model id, e.g. "google/gemini-3.1-flash-lite"
	MaxTokens int
}

func New(cfg Config) (*Translator, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("attribution translator: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("attribution translator: %w", err)
	}
	maxTok := cfg.MaxTokens
	if maxTok == 0 {
		maxTok = 200
	}
	return &Translator{Client: cli, Model: cfg.Model, MaxTokens: maxTok}, nil
}

type response struct {
	Translation string `json:"translation"`
}

// Translate selects a kind-specific prompt then performs one structured LLM
// call. Returns the translated string, or error.
func (t *Translator) Translate(ctx context.Context, text, fromLang, toLang string, kind library.AttributionKind) (string, error) {
	if text == "" {
		return "", fmt.Errorf("attribution translate: empty text")
	}
	prompt := pinnedPrompt
	maxTok := t.MaxTokens
	switch kind {
	case library.AttrBoost:
		prompt = boostPrompt
	case library.AttrMemory:
		prompt = memoryPrompt
		if maxTok < memoryMaxTokens {
			maxTok = memoryMaxTokens // notes are long; don't truncate
		}
	}
	system, user := splitPrompt(prompt)
	user = strings.ReplaceAll(user, "__FROM__", fromLang)
	user = strings.ReplaceAll(user, "__TO__", toLang)
	user = strings.ReplaceAll(user, "__TEXT__", text)
	// System also has __TO__ marker in the JSON template.
	system = strings.ReplaceAll(system, "__TO__", toLang)

	var raw response
	if _, err := t.Client.RunJSON(ctx, openaicompat.Call{
		Model:     t.Model,
		MaxTokens: maxTok,
		System:    system,
		User:      user,
	}, &raw); err != nil {
		return "", err
	}
	return strings.TrimSpace(raw.Translation), nil
}

func splitPrompt(s string) (system, user string) {
	const sep = "===USER==="
	idx := strings.Index(s, sep)
	if idx < 0 {
		return "", strings.TrimSpace(s)
	}
	return strings.TrimSpace(s[:idx]), strings.TrimSpace(s[idx+len(sep):])
}

var _ libraryport.AttributionTranslator = (*Translator)(nil)
