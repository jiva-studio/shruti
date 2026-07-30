// Package openaicompattranslate is the OpenAI-compatible Translator —
// asked once per never-seen-before raw string at auto-create time so a
// fresh dict entry is born with both ru and en rows. Talks to OpenRouter
// (or any compatible upstream) via the shared openaicompat client.
package openaicompattranslate

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/jiva-studio/lectorium/pipeline/openaicompat"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/dicttranslate"
)

//go:embed prompt.system.txt
var defaultSystemPrompt string

//go:embed prompt.user.txt
var defaultUserPrompt string

const ProviderName = "openai-compat"

type Translator struct {
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

func New(cfg Config) (*Translator, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compat translator: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("openai-compat translator: %w", err)
	}
	maxTok := cfg.MaxTokens
	if maxTok == 0 {
		maxTok = 256
	}
	sys, usr := defaultSystemPrompt, defaultUserPrompt
	if cfg.PromptPath != "" {
		raw, err := os.ReadFile(cfg.PromptPath)
		if err != nil {
			return nil, fmt.Errorf("read translator prompt %s: %w", cfg.PromptPath, err)
		}
		sys, usr = splitPrompt(string(raw))
	}
	return &Translator{
		Client:       cli,
		Model:        cfg.Model,
		MaxTokens:    maxTok,
		SystemPrompt: sys,
		UserPrompt:   usr,
	}, nil
}

type response struct {
	Names      map[string]string `json:"names"`
	ShortNames map[string]string `json:"short_names"`
}

func (t *Translator) Translate(ctx context.Context, kind catalog.Kind, query, fromLang string) (dicttranslate.Result, error) {
	user := t.UserPrompt
	user = strings.ReplaceAll(user, "__KIND__", string(kind))
	user = strings.ReplaceAll(user, "__LANG__", fromLang)
	user = strings.ReplaceAll(user, "__QUERY__", query)

	var raw response
	if _, err := t.Client.RunJSON(ctx, openaicompat.Call{
		Model:     t.Model,
		MaxTokens: t.MaxTokens,
		System:    t.SystemPrompt,
		User:      user,
	}, &raw); err != nil {
		return dicttranslate.Result{}, err
	}

	if raw.Names == nil {
		raw.Names = map[string]string{}
	}
	raw.Names[fromLang] = query

	out := dicttranslate.Result{Names: raw.Names}
	if kind == catalog.KindSource {
		if raw.ShortNames == nil {
			raw.ShortNames = map[string]string{}
		}
		raw.ShortNames[fromLang] = query
		out.ShortNames = raw.ShortNames
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

var _ dicttranslate.Translator = (*Translator)(nil)
