// Package openaicompat is a tiny, dependency-free chat-completions client
// shared by every LLM-backed component of the ingest pipeline (metadata
// extractor, transcript reviewer, resolver, translators, …), across both the
// shruti-mcp tool and the ingest worker.
//
// It lives in the pure `pipeline` library as an ADAPTER: it implements no
// domain logic, only the OpenAI Chat Completions API surface — meaning
// OpenRouter, native OpenAI, vLLM/Ollama in OpenAI-compat mode, DeepSeek, etc.
// all work without code changes. Kept stdlib-only so the pipeline module stays
// zero-dependency.
package openaicompat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Reasoning toggles upstream "thinking" budget. Empty string keeps the
// upstream default (most chat models have it off; reasoning models have
// it on). "off" sends max_tokens=0; "on" sends an enabled flag.
const (
	ReasoningDefault = ""
	ReasoningOff     = "off"
	ReasoningOn      = "on"
)

type Client struct {
	Endpoint string // base URL, e.g. https://openrouter.ai/api/v1
	APIKey   string
	HTTP     *http.Client
}

type Options struct {
	Endpoint string
	APIKey   string
}

func New(opts Options) (*Client, error) {
	if strings.TrimSpace(opts.APIKey) == "" {
		return nil, errors.New("openaicompat: api_key is empty")
	}
	if strings.TrimSpace(opts.Endpoint) == "" {
		return nil, errors.New("openaicompat: endpoint is empty")
	}
	return &Client{
		Endpoint: strings.TrimRight(opts.Endpoint, "/"),
		APIKey:   opts.APIKey,
		HTTP:     &http.Client{Timeout: 5 * time.Minute},
	}, nil
}

// Call is one chat completion invocation. System and User are sent as a
// two-message conversation; Reasoning controls per-call thinking; the rest
// mirrors the OpenAI request schema.
type Call struct {
	Model       string
	MaxTokens   int
	System      string
	User        string
	Temperature *float64
	Reasoning   string // ReasoningDefault | ReasoningOff | ReasoningOn
	// ResponseFormat, when set, is sent verbatim as the request's
	// `response_format` field (e.g. an OpenRouter json_schema structured-output
	// spec). Leave nil for free-form text completions.
	ResponseFormat json.RawMessage
	// Provider, when set, is sent verbatim as the request's `provider` field —
	// an OpenRouter routing preference such as {"sort":"latency"}. A gateway
	// serves one model from several upstreams, and they are not equally quick:
	// measured on gemini-3.1-flash-lite, one answered every call inside a
	// second and the other took up to five. Leave nil to let the gateway
	// choose.
	Provider json.RawMessage
}

// Result carries the assistant text plus per-call accounting that the
// caller can store in chunk_NNNN.json::models[] or hand to a billing log.
type Result struct {
	Text            string
	ModelID         string
	Endpoint        string
	TokensIn        int64
	TokensOut       int64
	ReasoningTokens int64
	CostUSD         float64
	Attempts        int
	StartedAt       time.Time
	FinishedAt      time.Time
}

type chatRequest struct {
	Model          string            `json:"model"`
	Messages       []chatMessage     `json:"messages"`
	Temperature    float64           `json:"temperature,omitempty"`
	MaxTokens      int               `json:"max_tokens,omitempty"`
	Stream         bool              `json:"stream"`
	Reasoning      *reasoningOptions `json:"reasoning,omitempty"`
	ResponseFormat json.RawMessage   `json:"response_format,omitempty"`
	Provider       json.RawMessage   `json:"provider,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type reasoningOptions struct {
	MaxTokens *int   `json:"max_tokens,omitempty"`
	Enabled   *bool  `json:"enabled,omitempty"`
	Effort    string `json:"effort,omitempty"`
}

// reasoningFromString turns the user-facing config string into a request
// payload. Accepted forms:
//
//	""              → no reasoning section sent (upstream default)
//	"off"           → reasoning.max_tokens=0 (forcibly disabled)
//	"on"            → reasoning.enabled=true (model decides budget)
//	"low" / "medium" / "high"  → reasoning.effort=<level>
//	"<int>"         → reasoning.max_tokens=<int> (explicit cap)
//
// Unknown strings fall back to "off"-style payload so misconfiguration
// trends toward cheaper rather than runaway thinking.
func reasoningFromString(s string) *reasoningOptions {
	switch s {
	case "":
		return nil
	case "off":
		zero := 0
		return &reasoningOptions{MaxTokens: &zero}
	case "on":
		t := true
		return &reasoningOptions{Enabled: &t}
	case "low", "medium", "high":
		return &reasoningOptions{Effort: s}
	default:
		// numeric → max_tokens cap
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			return &reasoningOptions{MaxTokens: &n}
		}
		// unknown → safe-default off
		zero := 0
		return &reasoningOptions{MaxTokens: &zero}
	}
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
		TotalTokens      int64 `json:"total_tokens"`
		Cost             any   `json:"cost,omitempty"`
		CostDetails      struct {
			UpstreamInferenceCost any `json:"upstream_inference_cost,omitempty"`
		} `json:"cost_details"`
		CompletionTokensDetails struct {
			ReasoningTokens int64 `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Code    any    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (c *Client) Run(ctx context.Context, call Call) (Result, error) {
	if call.Model == "" {
		return Result{}, errors.New("openaicompat: Call.Model is empty")
	}
	if call.MaxTokens <= 0 {
		return Result{}, errors.New("openaicompat: Call.MaxTokens must be > 0")
	}
	messages := []chatMessage{}
	if call.System != "" {
		messages = append(messages, chatMessage{Role: "system", Content: call.System})
	}
	messages = append(messages, chatMessage{Role: "user", Content: call.User})

	body := chatRequest{
		Model:     call.Model,
		Messages:  messages,
		MaxTokens: call.MaxTokens,
		Stream:    false,
	}
	if call.Temperature != nil {
		body.Temperature = *call.Temperature
	}
	body.Reasoning = reasoningFromString(call.Reasoning)
	body.ResponseFormat = call.ResponseFormat
	body.Provider = call.Provider

	raw, err := json.Marshal(body)
	if err != nil {
		return Result{}, err
	}
	url := c.Endpoint + "/chat/completions"

	const maxRetries = 4
	startedAt := time.Now().UTC()
	var (
		respBytes []byte
		cb        chatResponse
		attempts  int
	)
	for attempt := 0; attempt <= maxRetries; attempt++ {
		attempts = attempt + 1
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return Result{}, err
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)
		resp, err := c.HTTP.Do(httpReq)
		if err != nil {
			return Result{}, err
		}
		respBytes, _ = io.ReadAll(resp.Body)
		resp.Body.Close()

		cb = chatResponse{}
		if jerr := json.Unmarshal(respBytes, &cb); jerr != nil {
			return Result{}, fmt.Errorf("openaicompat decode: %w (body: %s)", jerr, truncate(string(respBytes), 400))
		}
		retryable := false
		if cb.Error != nil && (httpStatusFromAny(cb.Error.Code) == 429 || resp.StatusCode == 429) {
			retryable = true
		}
		if resp.StatusCode == http.StatusTooManyRequests || (resp.StatusCode >= 500 && resp.StatusCode < 600) {
			retryable = true
		}
		if !retryable || attempt == maxRetries {
			if cb.Error != nil {
				return Result{}, fmt.Errorf("openaicompat %s: %s", call.Model, cb.Error.Message)
			}
			if resp.StatusCode != http.StatusOK {
				return Result{}, fmt.Errorf("openaicompat %s HTTP %d: %s", call.Model, resp.StatusCode, truncate(string(respBytes), 400))
			}
			break
		}
		pause := time.Duration(1<<attempt)*time.Second + time.Duration(rand.Intn(500))*time.Millisecond
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-time.After(pause):
		}
	}
	finishedAt := time.Now().UTC()

	if len(cb.Choices) == 0 {
		return Result{}, fmt.Errorf("openaicompat %s: empty choices", call.Model)
	}

	return Result{
		Text:            cb.Choices[0].Message.Content,
		ModelID:         call.Model,
		Endpoint:        c.Endpoint,
		TokensIn:        cb.Usage.PromptTokens,
		TokensOut:       cb.Usage.CompletionTokens,
		ReasoningTokens: cb.Usage.CompletionTokensDetails.ReasoningTokens,
		CostUSD:         floatFromAny(cb.Usage.Cost, cb.Usage.CostDetails.UpstreamInferenceCost),
		Attempts:        attempts,
		StartedAt:       startedAt,
		FinishedAt:      finishedAt,
	}, nil
}

// RunJSON runs a Call and decodes the assistant reply (with leading
// ```json fences stripped) into out.
func (c *Client) RunJSON(ctx context.Context, call Call, out any) (Result, error) {
	res, err := c.Run(ctx, call)
	if err != nil {
		return res, err
	}
	cleaned := StripFences(res.Text)
	if cleaned == "" {
		return res, errors.New("openaicompat: empty body")
	}
	if err := json.Unmarshal([]byte(cleaned), out); err != nil {
		return res, fmt.Errorf("decode JSON from openaicompat: %w (raw: %s)", err, truncate(cleaned, 400))
	}
	return res, nil
}

// StripFences removes a leading ```json (or bare ```) and trailing ``` from
// content. Some models wrap JSON in markdown fences despite system-prompt
// instructions; trim is defensive.
func StripFences(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "```"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

func httpStatusFromAny(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	case string:
		var n int
		_, err := fmt.Sscanf(t, "%d", &n)
		if err != nil {
			return 0
		}
		return n
	}
	return 0
}

func floatFromAny(values ...any) float64 {
	for _, v := range values {
		switch t := v.(type) {
		case float64:
			if t != 0 {
				return t
			}
		case int:
			if t != 0 {
				return float64(t)
			}
		case int64:
			if t != 0 {
				return float64(t)
			}
		case json.Number:
			f, _ := t.Float64()
			if f != 0 {
				return f
			}
		case string:
			var f float64
			_, err := fmt.Sscanf(t, "%f", &f)
			if err == nil && f != 0 {
				return f
			}
		}
	}
	return 0
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
