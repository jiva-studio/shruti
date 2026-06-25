// Package authclient calls the auth service's internal subscription-grant
// endpoint. Billing never talks to RevenueCat — granting PRO is the auth
// service's job; we just tell it who to grant and for how long.
package authclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrNotConfigured is returned when the internal API token is unset — the
// caller leaves the order at `verified` for the reconcile worker to retry once
// the secret is wired.
var ErrNotConfigured = errors.New("authclient: internal API token not configured")

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: baseURL,
		Token:   token,
		HTTP:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) Configured() bool { return c.Token != "" }

type grantRequest struct {
	UserID   string `json:"userId"`
	Duration string `json:"duration"`
}

// Grant calls POST {BaseURL}/internal/subscription/grant. duration is the plan
// ("monthly"/"yearly"). Returns nil on 2xx; a non-nil error means the grant
// did not land and the order should stay at `verified` for re-drive.
func (c *Client) Grant(ctx context.Context, userID, duration string) error {
	if !c.Configured() {
		return ErrNotConfigured
	}
	buf, err := json.Marshal(grantRequest{UserID: userID, Duration: duration})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.BaseURL+"/internal/subscription/grant", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", c.Token)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("authclient: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("authclient: grant status=%d body=%s", resp.StatusCode, string(body))
	}
	return nil
}
