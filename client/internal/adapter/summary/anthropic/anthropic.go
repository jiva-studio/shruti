// Package anthropic implements port.Summarizer via the Anthropic (Claude)
// Messages API over raw net/http.
package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
)

const (
	apiURL     = "https://api.anthropic.com/v1/messages"
	apiVersion = "2023-06-01"
	model      = "claude-sonnet-5"
	maxTokens  = 2000
	// KeyEnv holds the Anthropic API key.
	KeyEnv = "ANTHROPIC_API_KEY"
)

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

// Summarizer calls Claude to summarize a meeting.
type Summarizer struct {
	HTTP *http.Client
}

// New returns a Claude summarizer with a sensible default HTTP client.
func New() *Summarizer {
	return &Summarizer{HTTP: &http.Client{Timeout: 120 * time.Second}}
}

var _ port.Summarizer = (*Summarizer)(nil)

func (s *Summarizer) Summarize(ctx context.Context, m *domain.Meeting) (domain.Summary, error) {
	key := os.Getenv(KeyEnv)
	if key == "" {
		return domain.Summary{}, fmt.Errorf("summary: %s not set", KeyEnv)
	}
	transcript := m.Transcript()
	if strings.TrimSpace(transcript) == "" {
		return domain.Summary{}, fmt.Errorf("summary: empty transcript")
	}

	reqBody := messagesRequest{
		Model:     model,
		MaxTokens: maxTokens,
		Thinking:  map[string]string{"type": "disabled"},
		Messages:  []message{{Role: "user", Content: fmt.Sprintf(promptTemplate, transcript)}},
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return domain.Summary{}, fmt.Errorf("summary: marshal request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(buf))
	if err != nil {
		return domain.Summary{}, fmt.Errorf("summary: build request: %w", err)
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("x-api-key", key)
	httpReq.Header.Set("anthropic-version", apiVersion)

	client := s.HTTP
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return domain.Summary{}, fmt.Errorf("summary: request: %w", err)
	}
	defer resp.Body.Close()

	var out messagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return domain.Summary{}, fmt.Errorf("summary: decode response (status %d): %w", resp.StatusCode, err)
	}
	if resp.StatusCode != http.StatusOK {
		if out.Error != nil {
			return domain.Summary{}, fmt.Errorf("summary: anthropic error (%d/%s): %s", resp.StatusCode, out.Error.Type, out.Error.Message)
		}
		return domain.Summary{}, fmt.Errorf("summary: anthropic http %d", resp.StatusCode)
	}

	var b strings.Builder
	for _, blk := range out.Content {
		if blk.Type == "text" {
			b.WriteString(blk.Text)
		}
	}
	text := strings.TrimSpace(b.String())
	if text == "" {
		return domain.Summary{}, fmt.Errorf("summary: empty summary (stop_reason=%s)", out.StopReason)
	}
	return domain.Summary{Text: text, Model: model}, nil
}

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
