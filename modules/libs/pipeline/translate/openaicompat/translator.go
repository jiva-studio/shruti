// Package openaicompattranslate translates short text (a lecture title today)
// into a target language via an OpenAI-compatible upstream (Gemini through
// OpenRouter). It implements the shared translate.Translator port.
package openaicompattranslate

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/pipeline/openaicompat"
	translateport "github.com/jiva-studio/shruti/pipeline/ports/translate"
)

//go:embed prompt.translate.txt
var translateSystemPrompt string

type Translator struct {
	Client    *openaicompat.Client
	Model     string
	MaxTokens int
	Reasoning string
}

type Config struct {
	Endpoint  string
	APIKey    string
	Model     string
	MaxTokens int
	Reasoning string
}

func New(cfg Config) (*Translator, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compat translator: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{Endpoint: cfg.Endpoint, APIKey: cfg.APIKey})
	if err != nil {
		return nil, fmt.Errorf("openai-compat translator: %w", err)
	}
	max := cfg.MaxTokens
	if max == 0 {
		max = 512
	}
	return &Translator{Client: cli, Model: cfg.Model, MaxTokens: max, Reasoning: cfg.Reasoning}, nil
}

func (t *Translator) Translate(ctx context.Context, text, fromLang, toLang string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" || toLang == "" || fromLang == toLang {
		return text, nil
	}
	sys := strings.ReplaceAll(translateSystemPrompt, "__TO_LANG__", toLang)
	res, err := t.Client.Run(ctx, openaicompat.Call{
		Model:       t.Model,
		MaxTokens:   t.MaxTokens,
		System:      sys,
		User:        text,
		Temperature: ptr(0.2),
		Reasoning:   t.Reasoning,
	})
	if err != nil {
		return "", fmt.Errorf("translate llm: %w", err)
	}
	out := strings.TrimSpace(openaicompat.StripFences(res.Text))
	if out == "" {
		return text, nil
	}
	return out, nil
}

func ptr(f float64) *float64 { return &f }

var _ translateport.Translator = (*Translator)(nil)
