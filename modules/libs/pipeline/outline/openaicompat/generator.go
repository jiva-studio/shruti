// Package openaicompatoutline generates a lecture outline (coarse chapter
// headings with timecodes) and a short description via an OpenAI-compatible
// upstream (Gemini through OpenRouter). It ports the two-pass approach used by
// the chat service's outline tool: one granular pass over the WHOLE transcript,
// then a collapse pass that merges the fine list into a handful of chapters.
package openaicompatoutline

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/jiva-studio/lectorium/pipeline/openaicompat"
	outlineport "github.com/jiva-studio/lectorium/pipeline/ports/outline"
)

//go:embed prompt.pass.txt
var passSystemPrompt string

//go:embed prompt.merge.txt
var mergeSystemPrompt string

const (
	// maxChapters is the ceiling the collapse pass merges down to. The fine
	// pass is deliberately granular (its count is unstable across runs); the
	// final count emerges from the content, not a clock.
	maxChapters = 8
	// maxMergePasses bounds the collapse loop so a stubborn merge can't spin.
	maxMergePasses = 5
)

// passResponseFormat is outlineResponseFormat plus the description, so the one
// call that reads the transcript returns both halves in a shape that parses.
var passResponseFormat = json.RawMessage(`{
  "type": "json_schema",
  "json_schema": {
    "name": "lecture_pass",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["items", "description"],
      "properties": {
        "description": {"type": "string"},
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["start", "title"],
            "properties": {
              "start": {"type": "string"},
              "title": {"type": "string"}
            }
          }
        }
      }
    }
  }
}`)

// outlineResponseFormat forces the merge pass to emit a structured
// JSON object {"items":[{start,title}]} instead of free-form text. Cheap models
// (gemini-flash) otherwise drift into echoing the transcript's "[MM:SS] title"
// line format, which is not JSON at all. A root object (not a bare array) is
// used because not every upstream accepts a top-level array in json_schema.
var outlineResponseFormat = json.RawMessage(`{
  "type": "json_schema",
  "json_schema": {
    "name": "lecture_outline",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["items"],
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["start", "title"],
            "properties": {
              "start": {"type": "string"},
              "title": {"type": "string"}
            }
          }
        }
      }
    }
  }
}`)

type Generator struct {
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

func New(cfg Config) (*Generator, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compat outline generator: model is empty")
	}
	cli, err := openaicompat.New(openaicompat.Options{Endpoint: cfg.Endpoint, APIKey: cfg.APIKey})
	if err != nil {
		return nil, fmt.Errorf("openai-compat outline generator: %w", err)
	}
	max := cfg.MaxTokens
	if max == 0 {
		max = 2048
	}
	return &Generator{Client: cli, Model: cfg.Model, MaxTokens: max, Reasoning: cfg.Reasoning}, nil
}

func (g *Generator) Outline(ctx context.Context, lectureText, lang string) (outlineport.OutlineResult, error) {
	granular, desc, err := g.pass(ctx, lectureText, lang)
	if err != nil {
		return outlineport.OutlineResult{}, err
	}
	coarse := g.collapse(ctx, granular, lang)
	return outlineport.OutlineResult{Granular: granular, Coarse: coarse, Description: desc}, nil
}

// PassPrompt is the system prompt of the one call that reads the transcript.
// Exported so the batch path can build the same request without going through
// the synchronous client.
func PassPrompt(lang string) string {
	return strings.ReplaceAll(passSystemPrompt, "__LANG__", lang)
}

// ParsePass decodes the reply of that call. Exported for the same reason.
func ParsePass(raw string) ([]outlineport.Item, string, error) {
	var obj struct {
		Items       json.RawMessage `json:"items"`
		Description string          `json:"description"`
	}
	if err := json.Unmarshal([]byte(openaicompat.StripFences(raw)), &obj); err != nil {
		return nil, "", fmt.Errorf("outline: parse reply: %w", err)
	}
	items, err := parseItems(string(obj.Items))
	if err != nil {
		return nil, "", err
	}
	if len(items) == 0 {
		return nil, "", fmt.Errorf("outline: empty result")
	}
	sortByStart(items)
	return items, strings.TrimSpace(obj.Description), nil
}

// pass runs the single call over the WHOLE transcript and returns the fine
// heading list (chronological) together with the description. The heading count
// is deliberately unstable across runs; the coarse count emerges later from the
// content, not a clock.
func (g *Generator) pass(ctx context.Context, lectureText, lang string) ([]outlineport.Item, string, error) {
	res, err := g.Client.Run(ctx, openaicompat.Call{
		Model:          g.Model,
		MaxTokens:      g.MaxTokens,
		System:         PassPrompt(lang),
		User:           lectureText,
		Temperature:    ptr(0.2),
		Reasoning:      g.Reasoning,
		ResponseFormat: passResponseFormat,
	})
	if err != nil {
		return nil, "", fmt.Errorf("outline llm: %w", err)
	}
	return ParsePass(res.Text)
}

// collapse merges the granular list down to a handful of coarse chapters. A
// failed or non-shrinking merge keeps the finer outline rather than losing it.
// It does not mutate the input slice, so the granular pass survives intact for
// the offline topic artifact.
func (g *Generator) collapse(ctx context.Context, granular []outlineport.Item, lang string) []outlineport.Item {
	items := append([]outlineport.Item(nil), granular...)
	for passes := 0; len(items) > maxChapters && passes < maxMergePasses; passes++ {
		before := len(items)
		merged, err := g.merge(ctx, items, lang)
		if err != nil || len(merged) == 0 {
			break
		}
		sortByStart(merged)
		items = merged
		if len(items) >= before {
			break
		}
	}
	return items
}

func (g *Generator) merge(ctx context.Context, items []outlineport.Item, lang string) ([]outlineport.Item, error) {
	sys := strings.ReplaceAll(mergeSystemPrompt, "__LANG__", lang)
	sys = strings.ReplaceAll(sys, "__MAX_CHAPTERS__", strconv.Itoa(maxChapters))
	var b strings.Builder
	for _, it := range items {
		fmt.Fprintf(&b, "[%s] %s\n", fmtTS(it.StartMs), it.Title)
	}
	res, err := g.Client.Run(ctx, openaicompat.Call{
		Model:          g.Model,
		MaxTokens:      g.MaxTokens,
		System:         sys,
		User:           b.String(),
		Temperature:    ptr(0.2),
		Reasoning:      g.Reasoning,
		ResponseFormat: outlineResponseFormat,
	})
	if err != nil {
		return nil, err
	}
	return parseItems(res.Text)
}

// parseItems decodes the LLM's JSON array of {start,title}. start may be a
// "MM:SS"/"HH:MM:SS" string (the prompt's contract) or a numeric ms value.
func parseItems(raw string) ([]outlineport.Item, error) {
	cleaned := openaicompat.StripFences(raw)
	type item struct {
		Start   json.RawMessage `json:"start"`
		StartMs json.RawMessage `json:"start_ms"`
		Title   string          `json:"title"`
	}
	// Structured output returns the object {"items":[...]}; a bare array is
	// still accepted so the parser survives a provider that ignores
	// response_format.
	var parsed []item
	var wrapper struct {
		Items []item `json:"items"`
	}
	if err := json.Unmarshal([]byte(cleaned), &wrapper); err == nil && wrapper.Items != nil {
		parsed = wrapper.Items
	} else if err := json.Unmarshal([]byte(cleaned), &parsed); err != nil {
		return nil, fmt.Errorf("outline: parse llm json: %w", err)
	}
	out := make([]outlineport.Item, 0, len(parsed))
	for _, it := range parsed {
		title := strings.TrimSpace(it.Title)
		if title == "" {
			continue
		}
		ms, ok := parseStart(it.Start)
		if !ok {
			ms, ok = parseStart(it.StartMs)
		}
		if !ok {
			continue
		}
		out = append(out, outlineport.Item{Title: title, StartMs: ms})
	}
	return out, nil
}

func parseStart(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err == nil {
		return int64(n), true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return parseTS(s), true
	}
	return 0, false
}

func sortByStart(items []outlineport.Item) {
	sort.SliceStable(items, func(i, j int) bool { return items[i].StartMs < items[j].StartMs })
}

func fmtTS(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	s := ms / 1000
	h := s / 3600
	m := (s % 3600) / 60
	sec := s % 60
	if h > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", h, m, sec)
	}
	return fmt.Sprintf("%02d:%02d", m, sec)
}

func parseTS(ts string) int64 {
	parts := strings.Split(strings.TrimSpace(ts), ":")
	nums := make([]int64, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64)
		if err != nil {
			return 0
		}
		nums = append(nums, n)
	}
	switch len(nums) {
	case 2:
		return (nums[0]*60 + nums[1]) * 1000
	case 3:
		return (nums[0]*3600 + nums[1]*60 + nums[2]) * 1000
	default:
		return 0
	}
}

func ptr(f float64) *float64 { return &f }

var _ outlineport.Generator = (*Generator)(nil)
