// Package openaicompatresolver maps a raw QUERY string against a candidate
// set and returns one (or none) matched id with a confidence level. Runs
// on top of the shared openai-compat chat completions client (OpenRouter
// by default, any compatible upstream by config).
package openaicompatresolver

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/infra/openaicompat"
	catalogport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

//go:embed prompt.system.txt
var defaultSystemPrompt string

//go:embed prompt.user.txt
var defaultUserPrompt string

const ProviderName = "openai-compat"

type Resolver struct {
	Client       *openaicompat.Client
	Model        string
	MaxTokens    int
	SystemPrompt string
	UserPrompt   string
	NameAlias    string
}

type Config struct {
	NameAlias  string
	Endpoint   string
	APIKey     string
	Model      string
	MaxTokens  int
	PromptPath string
}

func New(cfg Config) (*Resolver, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compat resolver: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("openai-compat resolver: %w", err)
	}
	max := cfg.MaxTokens
	if max == 0 {
		max = 1024
	}
	sys, usr := defaultSystemPrompt, defaultUserPrompt
	if cfg.PromptPath != "" {
		raw, err := os.ReadFile(cfg.PromptPath)
		if err != nil {
			return nil, fmt.Errorf("read resolver prompt %s: %w", cfg.PromptPath, err)
		}
		sys, usr = splitPrompt(string(raw))
	}
	alias := cfg.NameAlias
	if alias == "" {
		alias = ProviderName
	}
	return &Resolver{
		Client:       cli,
		Model:        cfg.Model,
		MaxTokens:    max,
		SystemPrompt: sys,
		UserPrompt:   usr,
		NameAlias:    alias,
	}, nil
}

func (r *Resolver) Name() string { return r.NameAlias }

type response struct {
	MatchedID  *string `json:"matched_id"`
	Confidence string  `json:"confidence"`
	Reasoning  string  `json:"reasoning"`
}

func (r *Resolver) Resolve(ctx context.Context, req catalogport.ResolveRequest) (catalogport.ResolveResponse, error) {
	if len(req.Candidates) == 0 {
		return catalogport.ResolveResponse{
			Confidence: catalogport.ConfNone,
			Reasoning:  "no candidates available",
			Provider:   r.Name(),
		}, nil
	}

	candJSON, err := json.Marshal(req.Candidates)
	if err != nil {
		return catalogport.ResolveResponse{}, err
	}

	user := r.UserPrompt
	user = strings.ReplaceAll(user, "__KIND__", string(req.Kind))
	user = strings.ReplaceAll(user, "__QUERY__", req.Query)
	user = strings.ReplaceAll(user, "__HINT__", req.Hint)
	user = strings.ReplaceAll(user, "__CANDIDATES__", string(candJSON))

	var raw response
	if _, err := r.Client.RunJSON(ctx, openaicompat.Call{
		Model:     r.Model,
		MaxTokens: r.MaxTokens,
		System:    r.SystemPrompt,
		User:      user,
	}, &raw); err != nil {
		return catalogport.ResolveResponse{}, err
	}
	out := catalogport.ResolveResponse{
		Confidence: catalogport.Confidence(strings.ToLower(raw.Confidence)),
		Reasoning:  raw.Reasoning,
		Provider:   r.Name(),
	}
	if raw.MatchedID != nil {
		out.MatchedID = *raw.MatchedID
	}
	if out.Confidence == "" {
		out.Confidence = catalogport.ConfNone
	}
	return out, nil
}

func splitPrompt(s string) (system, user string) {
	const sep = "===USER==="
	idx := strings.Index(s, sep)
	if idx < 0 {
		return "", strings.TrimSpace(s)
	}
	return strings.TrimSpace(s[:idx]), strings.TrimSpace(s[idx+len(sep):])
}

var _ catalogport.Resolver = (*Resolver)(nil)
