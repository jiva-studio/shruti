// Package httpcdn fetches published catalog files over HTTPS.
package httpcdn

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Source fetches public/* keys via anonymous HTTPS GET against ReadBaseURL.
// Implements ports/cdn.Source.
type Source struct {
	BaseURL string
	HTTP    *http.Client
}

func New(baseURL string) *Source {
	return &Source{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 5 * time.Minute},
	}
}

func (s *Source) GetJSON(ctx context.Context, key string, out any) error {
	body, err := s.GetFile(ctx, key)
	if err != nil {
		return err
	}
	defer body.Close()
	return json.NewDecoder(body).Decode(out)
}

func (s *Source) GetFile(ctx context.Context, key string) (io.ReadCloser, error) {
	url := s.BaseURL + "/" + strings.TrimLeft(key, "/")
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	if resp.StatusCode/100 != 2 {
		bodyTail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		return nil, fmt.Errorf("GET %s: %s (%s)", url, resp.Status, string(bodyTail))
	}
	return resp.Body, nil
}
