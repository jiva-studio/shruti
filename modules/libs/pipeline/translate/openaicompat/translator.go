// Package openaicompattranslate translates short text (a lecture title today)
// into a target language via an OpenAI-compatible upstream (Gemini through
// OpenRouter). It implements the shared translate.Translator port.
package openaicompattranslate

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/pipeline/openaicompat"
	translateport "github.com/jiva-studio/shruti/pipeline/ports/translate"
)

//go:embed prompt.translate.txt
var translateSystemPrompt string

//go:embed prompt.batch.txt
var batchSystemPrompt string

// batchSize bounds how many lines go in one LLM round — small enough to stay
// within output limits and keep the model aligned, large enough to avoid a call
// per sentence.
const batchSize = 25

// batchResponseFormat forces a {"items":[...]} object so the model can't drift
// into prose; a root object (not a bare array) is used because not every
// upstream accepts a top-level array in json_schema.
var batchResponseFormat = json.RawMessage(`{
  "type": "json_schema",
  "json_schema": {
    "name": "translated_lines",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["items"],
      "properties": {
        "items": {"type": "array", "items": {"type": "string"}}
      }
    }
  }
}`)

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
		max = 4096 // headroom for a batch of translated transcript lines
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

// TranslateBatch translates texts in chunks and returns a slice of the same
// length and order. On a chunk failure or a length mismatch the affected inputs
// fall back to their source text, so the result always aligns 1:1 with blocks.
func (t *Translator) TranslateBatch(ctx context.Context, texts []string, fromLang, toLang string) ([]string, error) {
	out := make([]string, len(texts))
	copy(out, texts)
	if toLang == "" || fromLang == toLang {
		return out, nil
	}
	sys := strings.ReplaceAll(batchSystemPrompt, "__TO_LANG__", toLang)
	for start := 0; start < len(texts); start += batchSize {
		end := start + batchSize
		if end > len(texts) {
			end = len(texts)
		}
		translated, err := t.batch(ctx, sys, texts[start:end])
		if err != nil || len(translated) != end-start {
			continue // keep the source lines for this chunk
		}
		for i, s := range translated {
			if strings.TrimSpace(s) != "" {
				out[start+i] = s
			}
		}
	}
	return out, nil
}

func (t *Translator) batch(ctx context.Context, sys string, chunk []string) ([]string, error) {
	payload, err := json.Marshal(struct {
		Items []string `json:"items"`
	}{Items: chunk})
	if err != nil {
		return nil, err
	}
	res, err := t.Client.Run(ctx, openaicompat.Call{
		Model:          t.Model,
		MaxTokens:      t.MaxTokens,
		System:         sys,
		User:           string(payload),
		Temperature:    ptr(0.2),
		Reasoning:      t.Reasoning,
		ResponseFormat: batchResponseFormat,
	})
	if err != nil {
		return nil, fmt.Errorf("translate batch llm: %w", err)
	}
	var wrapper struct {
		Items []string `json:"items"`
	}
	if err := json.Unmarshal([]byte(openaicompat.StripFences(res.Text)), &wrapper); err != nil {
		return nil, fmt.Errorf("translate batch parse: %w", err)
	}
	return wrapper.Items, nil
}

func ptr(f float64) *float64 { return &f }

var _ translateport.Translator = (*Translator)(nil)
