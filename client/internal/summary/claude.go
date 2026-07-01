package summary

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Anthropic Messages API constants. Kept in one place so the model / endpoint
// are trivially swappable if params drift.
const (
	anthropicURL     = "https://api.anthropic.com/v1/messages"
	anthropicVersion = "2023-06-01"
	// model: Claude Sonnet 5 — high-quality summarization at Sonnet cost.
	claudeModel  = "claude-sonnet-5"
	claudeMaxTok = 2000
)

// APIKeyEnv is the environment variable holding the Anthropic API key.
const APIKeyEnv = "ANTHROPIC_API_KEY"

// promptTemplate asks for a Russian-language meeting summary with key points
// and action items.
const promptTemplate = `Ниже приведена расшифровка встречи (стенограмма). ` +
	`Составь краткое резюме встречи на русском языке.

Резюме должно содержать:
1. Краткий обзор (2–4 предложения).
2. Ключевые моменты (маркированный список).
3. Принятые решения (если есть).
4. Задачи и действия (action items) с указанием ответственных, если это можно понять из текста.

Расшифровка:
"""
%s
"""`

// Claude summarizes transcripts via the Anthropic Messages API using raw
// net/http (per the frozen client contract). The API key is read from the
// ANTHROPIC_API_KEY environment variable.
type Claude struct {
	// HTTP is the client used for requests; nil defaults to a 120s client.
	HTTP *http.Client
}

// NewClaude returns a Claude summarizer with a sensible default HTTP client.
func NewClaude() *Claude {
	return &Claude{HTTP: &http.Client{Timeout: 120 * time.Second}}
}

// thinking is disabled so the (adaptive-by-default on Sonnet 5) thinking budget
// does not eat into the max_tokens cap for what is a short summary.
type messagesRequest struct {
	Model     string            `json:"model"`
	MaxTokens int               `json:"max_tokens"`
	Thinking  map[string]string `json:"thinking"`
	Messages  []message         `json:"messages"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type messagesResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StopReason string `json:"stop_reason"`
	Error      *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Summarize sends the transcript to Claude and returns the model's summary.
func (c *Claude) Summarize(ctx context.Context, transcript string) (string, error) {
	key := os.Getenv(APIKeyEnv)
	if key == "" {
		return "", fmt.Errorf("summary: %s not set", APIKeyEnv)
	}
	if strings.TrimSpace(transcript) == "" {
		return "", fmt.Errorf("summary: empty transcript")
	}

	reqBody := messagesRequest{
		Model:     claudeModel,
		MaxTokens: claudeMaxTok,
		Thinking:  map[string]string{"type": "disabled"},
		Messages: []message{
			{Role: "user", Content: fmt.Sprintf(promptTemplate, transcript)},
		},
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("summary: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, anthropicURL, bytes.NewReader(buf))
	if err != nil {
		return "", fmt.Errorf("summary: build request: %w", err)
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("x-api-key", key)
	httpReq.Header.Set("anthropic-version", anthropicVersion)

	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("summary: request: %w", err)
	}
	defer resp.Body.Close()

	var out messagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("summary: decode response (status %d): %w", resp.StatusCode, err)
	}
	if resp.StatusCode != http.StatusOK {
		if out.Error != nil {
			return "", fmt.Errorf("summary: anthropic error (%d/%s): %s", resp.StatusCode, out.Error.Type, out.Error.Message)
		}
		return "", fmt.Errorf("summary: anthropic http %d", resp.StatusCode)
	}

	var b strings.Builder
	for _, blk := range out.Content {
		if blk.Type == "text" {
			b.WriteString(blk.Text)
		}
	}
	text := strings.TrimSpace(b.String())
	if text == "" {
		return "", fmt.Errorf("summary: empty summary (stop_reason=%s)", out.StopReason)
	}
	return text, nil
}
