// Package embed turns a query string into a dense vector via an
// OpenAI-compatible /embeddings endpoint — the same call the chat indexer
// makes, so query and corpus vectors share one space. Ported verbatim from
// search-mcp.
package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/config"
)

// Client embeds a single query. We only ever embed one string at a time
// (interactive search), so there's no batch path like the indexer's.
type Client struct {
	http     *http.Client
	baseURL  string
	model    string
	apiKey   string
	queryPfx string
}

// New builds the embedder from config, resolving the provider's base URL the
// same way embed.py's _build_embedder does.
func New(c config.Config) *Client {
	baseURL := c.EmbedBaseURL
	apiKey := c.OpenAIAPIKey
	if c.EmbedProvider == "openrouter" {
		if baseURL == "" {
			baseURL = "https://openrouter.ai/api/v1"
		}
		apiKey = c.OpenRouterAPIKey
	} else if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	return &Client{
		http:     &http.Client{Timeout: 30 * time.Second},
		baseURL:  baseURL,
		model:    c.EmbedModel,
		apiKey:   apiKey,
		queryPfx: c.EmbedQueryPrefix,
	}
}

type embedRequest struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

type embedResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

// Query embeds one query string, applying the configured query prefix.
func (c *Client) Query(ctx context.Context, text string) ([]float32, error) {
	input := text
	if c.queryPfx != "" {
		input = c.queryPfx + text
	}
	body, err := json.Marshal(embedRequest{Model: c.model, Input: input})
	if err != nil {
		return nil, fmt.Errorf("marshal embed request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build embed request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embed request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return nil, fmt.Errorf("embed endpoint %d: %s", resp.StatusCode, buf.String())
	}
	var out embedResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode embed response: %w", err)
	}
	if len(out.Data) == 0 || len(out.Data[0].Embedding) == 0 {
		return nil, fmt.Errorf("embed endpoint returned no vector")
	}
	return out.Data[0].Embedding, nil
}
