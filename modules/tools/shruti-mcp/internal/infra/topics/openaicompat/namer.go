// Package openaicompattopics names topic clusters via an OpenAI-compatible LLM
// (Gemini Flash-Lite through OpenRouter) — one short call per cluster turning a
// handful of representative headings into a canonical ru/en topic name.
package openaicompattopics

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/infra/openaicompat"
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
	max := cfg.MaxTokens
	if max == 0 {
		max = 200
	}
	return &Namer{client: cli, model: cfg.Model, maxTokens: max, reasoning: cfg.Reasoning}, nil
}

// NameCluster returns a canonical ru/en name for one cluster of headings.
func (n *Namer) NameCluster(ctx context.Context, sampleTitles []string) (string, string, error) {
	if len(sampleTitles) == 0 {
		return "", "", fmt.Errorf("name cluster: no sample titles")
	}
	user := strings.Join(sampleTitles, "\n")
	var out struct {
		Ru string `json:"ru"`
		En string `json:"en"`
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
		return "", "", fmt.Errorf("name cluster llm: %w", err)
	}
	ru, en := strings.TrimSpace(out.Ru), strings.TrimSpace(out.En)
	if ru == "" || en == "" {
		return "", "", fmt.Errorf("name cluster: empty ru/en in response")
	}
	return ru, en, nil
}
