// Package openaicompatreview is the review-stage adapter on top of the
// shared internal/infra/openaicompat chat-completions client.
//
// All transcript-review traffic flows through OpenRouter (or any other
// OpenAI-compatible endpoint) — review is just the longest-running
// caller, with idx-set validation and per-chunk segment contracts that
// the shared client doesn't know about.
package openaicompatreview

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/infra/openaicompat"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/infra/review/prompts"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/review"
)

var defaultSystemPrompt = prompts.System
var defaultUserPrompt = prompts.User

// Reasoning re-exports for callers that don't import internal/infra/openaicompat directly.
const (
	ReasoningDefault = openaicompat.ReasoningDefault
	ReasoningOff     = openaicompat.ReasoningOff
	ReasoningOn      = openaicompat.ReasoningOn
)

type Reviewer struct {
	NameAlias    string // YAML alias, e.g. "gemini-3-flash-preview"
	Client       *openaicompat.Client
	Model        string // upstream id, e.g. google/gemini-3-flash-preview
	MaxTokens    int
	Reasoning    string
	SystemPrompt string
	UserPrompt   string
}

type Config struct {
	NameAlias string
	Endpoint  string
	APIKey    string
	Model     string
	MaxTokens int
	Reasoning string
}

func New(cfg Config) (*Reviewer, error) {
	if cfg.NameAlias == "" {
		return nil, fmt.Errorf("openai-compat review: name alias is empty")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compat review %q: model is empty", cfg.NameAlias)
	}
	cli, err := openaicompat.New(openaicompat.Options{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("openai-compat review %q: %w", cfg.NameAlias, err)
	}
	max := cfg.MaxTokens
	if max == 0 {
		max = 4096
	}
	return &Reviewer{
		NameAlias:    cfg.NameAlias,
		Client:       cli,
		Model:        cfg.Model,
		MaxTokens:    max,
		Reasoning:    cfg.Reasoning,
		SystemPrompt: defaultSystemPrompt,
		UserPrompt:   defaultUserPrompt,
	}, nil
}

func (r *Reviewer) Name() string { return r.NameAlias }

type chunkContent struct {
	Segments  []review.ChunkSegment `json:"segments"`
	Sentences [][]int               `json:"sentences"`
}

func (r *Reviewer) ReviewChunk(ctx context.Context, req review.ChunkRequest) (review.ChunkResponse, error) {
	chunkJSON, err := json.Marshal(req.Segments)
	if err != nil {
		return review.ChunkResponse{}, err
	}
	prevJSON := []byte("[]")
	if len(req.PrevTail) > 0 {
		prevJSON, _ = json.Marshal(req.PrevTail)
	}
	user := r.UserPrompt
	user = strings.ReplaceAll(user, "__LANG__", req.Language)
	user = strings.ReplaceAll(user, "__CHUNK__", string(chunkJSON))
	user = strings.ReplaceAll(user, "__PREV_TAIL__", string(prevJSON))
	if req.ExtraPrompt != "" {
		// Inject between PREV_TAIL and CHUNK so hints sit fresh in
		// context right before the segments. Falls back to prepend if
		// the marker isn't present.
		marker := "CHUNK:"
		if i := strings.Index(user, marker); i >= 0 {
			user = user[:i] + req.ExtraPrompt + "\n" + user[i:]
		} else {
			user = req.ExtraPrompt + "\n" + user
		}
	}

	temp := 0.1
	var out chunkContent
	res, err := r.Client.RunJSON(ctx, openaicompat.Call{
		Model:       r.Model,
		MaxTokens:   r.MaxTokens,
		System:      r.SystemPrompt,
		User:        user,
		Temperature: &temp,
		Reasoning:   r.Reasoning,
	}, &out)
	if err != nil {
		return review.ChunkResponse{}, fmt.Errorf("openai-compat %q: %w", r.NameAlias, err)
	}

	entry := review.ModelEntry{
		Role:            "single",
		Name:            r.NameAlias,
		ModelID:         res.ModelID,
		Endpoint:        res.Endpoint,
		TokensIn:        res.TokensIn,
		TokensOut:       res.TokensOut,
		ReasoningTokens: res.ReasoningTokens,
		CostUSD:         res.CostUSD,
		Attempts:        res.Attempts,
		StartedAt:       res.StartedAt,
		FinishedAt:      res.FinishedAt,
	}
	return review.ChunkResponse{
		Segments:  out.Segments,
		Sentences: out.Sentences,
		Models:    []review.ModelEntry{entry},
	}, nil
}

var _ review.Reviewer = (*Reviewer)(nil)
