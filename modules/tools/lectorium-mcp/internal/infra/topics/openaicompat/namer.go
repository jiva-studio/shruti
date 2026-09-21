// Package openaicompattopics names topic clusters via an OpenAI-compatible LLM
// (Gemini Flash-Lite through OpenRouter) — one short call per cluster turning a
// handful of representative headings into a canonical topic name (full + short)
// in each requested language.
package openaicompattopics

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	domaintopics "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/topics"
	"github.com/jiva-studio/lectorium/pipeline/openaicompat"
)

//go:embed prompt.name.txt
var namePrompt string

type Config struct {
	Endpoint  string
	APIKey    string
	Model     string
	MaxTokens int
	Reasoning string
}

type Namer struct {
	client    *openaicompat.Client
	model     string
	maxTokens int
	reasoning string
}

func New(cfg Config) (*Namer, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("topic namer: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{Endpoint: cfg.Endpoint, APIKey: cfg.APIKey})
	if err != nil {
		return nil, fmt.Errorf("topic namer: %w", err)
	}
	maxTokens := cfg.MaxTokens
	if maxTokens == 0 {
		maxTokens = 200
	}
	return &Namer{client: cli, model: cfg.Model, maxTokens: maxTokens, reasoning: cfg.Reasoning}, nil
}

// NameCluster names one cluster of headings in every requested language,
// returning a full and (optional) short name per language. The languages are
// passed in (derived from the corpus) so no locale is hardcoded.
func (n *Namer) NameCluster(ctx context.Context, sampleTitles, languages []string) (domaintopics.Names, error) {
	if len(sampleTitles) == 0 {
		return domaintopics.Names{}, fmt.Errorf("name cluster: no sample titles")
	}
	if len(languages) == 0 {
		return domaintopics.Names{}, fmt.Errorf("name cluster: no target languages")
	}
	user := fmt.Sprintf("Languages (codes): %s\n\nHeadings:\n%s",
		strings.Join(languages, ", "), strings.Join(sampleTitles, "\n"))
	var out struct {
		Full  map[string]string `json:"full"`
		Short map[string]string `json:"short"`
	}
	temp := 0.2
	if _, err := n.client.RunJSON(ctx, openaicompat.Call{
		Model:       n.model,
		MaxTokens:   n.maxTokens,
		System:      namePrompt,
		User:        user,
		Temperature: &temp,
		Reasoning:   n.reasoning,
	}, &out); err != nil {
		return domaintopics.Names{}, fmt.Errorf("name cluster llm: %w", err)
	}
	names := domaintopics.Names{
		Full:  make(map[string]string, len(languages)),
		Short: make(map[string]string, len(languages)),
	}
	for _, lang := range languages {
		full := strings.TrimSpace(out.Full[lang])
		if full == "" {
			return domaintopics.Names{}, fmt.Errorf("name cluster: missing full name for %q", lang)
		}
		names.Full[lang] = full
		if short := strings.TrimSpace(out.Short[lang]); short != "" {
			names.Short[lang] = short
		}
	}
	return names, nil
}
