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

	"github.com/jiva-studio/shruti/pipeline/openaicompat"
	"github.com/jiva-studio/shruti/pipeline/ports/review"
	"github.com/jiva-studio/shruti/pipeline/review/prompts"
)

var defaultSystemPrompt = prompts.System
var linesSystemPrompt = prompts.SystemLines
var defaultUserPrompt = prompts.User

// Reasoning re-exports for callers that don't import internal/infra/openaicompat directly.
const (
	ReasoningDefault = openaicompat.ReasoningDefault
	ReasoningOff     = openaicompat.ReasoningOff
	ReasoningOn      = openaicompat.ReasoningOn
)

// Format selects the wire shape of the reply. FormatJSON is the original
// contract: every segment returned, sentences spelled out in full. FormatLines
// asks only for the segments that changed and the sentence-end boundaries,
// which measured ~45% cheaper at equal accuracy — output is billed at several
// times the input rate, and most of it was unchanged text.
type Format string

const (
	FormatJSON  Format = "json"
	FormatLines Format = "lines"
)

type Reviewer struct {
	NameAlias    string // YAML alias, e.g. "gemini-3-flash-preview"
	Client       *openaicompat.Client
	Model        string // upstream id, e.g. google/gemini-3-flash-preview
	MaxTokens    int
	Reasoning    string
	Format       Format
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
	Format    Format // empty = FormatJSON
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
	maxTokens := cfg.MaxTokens
	if maxTokens == 0 {
		maxTokens = 4096
	}
	format := cfg.Format
	if format == "" {
		format = FormatJSON
	}
	system := defaultSystemPrompt
	if format == FormatLines {
		system = linesSystemPrompt
	} else if format != FormatJSON {
		return nil, fmt.Errorf("openai-compat review %q: unknown format %q", cfg.NameAlias, cfg.Format)
	}
	return &Reviewer{
		NameAlias:    cfg.NameAlias,
		Client:       cli,
		Model:        cfg.Model,
		MaxTokens:    maxTokens,
		Reasoning:    cfg.Reasoning,
		Format:       format,
		SystemPrompt: system,
		UserPrompt:   defaultUserPrompt,
	}, nil
}

func (r *Reviewer) Name() string { return r.NameAlias }

type chunkContent struct {
	Segments  []review.ChunkSegment `json:"segments"`
	Sentences [][]int               `json:"sentences"`
}

func (r *Reviewer) ReviewChunk(ctx context.Context, req review.ChunkRequest) (review.ChunkResponse, error) {
	user := BuildUserPrompt(r.UserPrompt, req)

	temp := 0.1
	call := openaicompat.Call{
		Model:       r.Model,
		MaxTokens:   r.MaxTokens,
		System:      r.SystemPrompt,
		User:        user,
		Temperature: &temp,
		Reasoning:   r.Reasoning,
	}

	var out chunkContent
	var res openaicompat.Result
	var err error
	if r.Format == FormatLines {
		res, err = r.Client.Run(ctx, call)
		if err == nil {
			out.Segments, out.Sentences, err = ParseLines(
				openaicompat.StripFences(res.Text), req.Segments)
		}
	} else {
		res, err = r.Client.RunJSON(ctx, call, &out)
	}
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

// BuildUserPrompt fills the user template for one chunk. Exported so the
// batch path builds byte-identical prompts.
func BuildUserPrompt(tmpl string, req review.ChunkRequest) string {
	chunkJSON, _ := json.Marshal(req.Segments)
	prevJSON := []byte("[]")
	if len(req.PrevTail) > 0 {
		prevJSON, _ = json.Marshal(req.PrevTail)
	}
	user := tmpl
	user = strings.ReplaceAll(user, "__LANG__", req.Language)
	user = strings.ReplaceAll(user, "__CHUNK__", string(chunkJSON))
	user = strings.ReplaceAll(user, "__PREV_TAIL__", string(prevJSON))
	if req.ExtraPrompt != "" {
		// Hints sit right before the segments so they stay fresh in context.
		marker := "CHUNK:"
		if i := strings.Index(user, marker); i >= 0 {
			user = user[:i] + req.ExtraPrompt + "\n" + user[i:]
		} else {
			user = req.ExtraPrompt + "\n" + user
		}
	}
	return user
}

// LinesSystemPrompt is the system text the batch path must send to get the
// same line format back.
var LinesSystemPrompt = linesSystemPrompt

var _ review.Reviewer = (*Reviewer)(nil)
