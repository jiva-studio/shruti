// Package openrouterimage implements ports/imagegen.Generator against an
// OpenRouter-compatible chat-completions endpoint with image modality
// (e.g. google/gemini-2.5-flash-image). Mirrors the badge-gen gen.sh flow:
// POST with modalities:["image","text"], read the base64 data URI back from
// choices[0].message.images[0].image_url.url.
package openrouterimage

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/imagegen"
)

type Config struct {
	Endpoint string // OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1
	APIKey   string
	Model    string
}

type Client struct {
	cfg  Config
	http *http.Client
}

func New(cfg Config) (*Client, error) {
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("openrouterimage: api_key required")
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = "https://openrouter.ai/api/v1"
	}
	if cfg.Model == "" {
		cfg.Model = "google/gemini-2.5-flash-image"
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: 120 * time.Second}}, nil
}

func (c *Client) Generate(ctx context.Context, prompt string, refs ...imagegen.Reference) ([]byte, string, error) {
	content := []any{map[string]any{"type": "text", "text": prompt}}
	for _, r := range refs {
		if len(r.Data) == 0 {
			continue
		}
		ct := r.ContentType
		if ct == "" {
			ct = "image/jpeg"
		}
		content = append(content, map[string]any{
			"type": "image_url",
			"image_url": map[string]any{
				"url": "data:" + ct + ";base64," + base64.StdEncoding.EncodeToString(r.Data),
			},
		})
	}
	reqBody, _ := json.Marshal(map[string]any{
		"model":      c.cfg.Model,
		"modalities": []string{"image", "text"},
		"messages": []any{
			map[string]any{"role": "user", "content": content},
		},
	})

	url := strings.TrimRight(c.cfg.Endpoint, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("openrouterimage: request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("openrouterimage: status %d: %s", resp.StatusCode, truncate(body, 300))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Images []struct {
					ImageURL struct {
						URL string `json:"url"`
					} `json:"image_url"`
				} `json:"images"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, "", fmt.Errorf("openrouterimage: decode: %w", err)
	}
	if len(parsed.Choices) == 0 || len(parsed.Choices[0].Message.Images) == 0 {
		return nil, "", fmt.Errorf("openrouterimage: no image in response: %s", truncate(body, 300))
	}

	dataURI := parsed.Choices[0].Message.Images[0].ImageURL.URL
	// dataURI is "data:image/png;base64,...."; split off the prefix.
	comma := strings.IndexByte(dataURI, ',')
	if comma < 0 || !strings.HasPrefix(dataURI, "data:") {
		return nil, "", fmt.Errorf("openrouterimage: unexpected image url shape")
	}
	contentType := "image/png"
	if semi := strings.IndexByte(dataURI[5:comma], ';'); semi >= 0 {
		contentType = dataURI[5 : 5+semi]
	}
	raw, err := base64.StdEncoding.DecodeString(dataURI[comma+1:])
	if err != nil {
		return nil, "", fmt.Errorf("openrouterimage: base64: %w", err)
	}
	return raw, contentType, nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
