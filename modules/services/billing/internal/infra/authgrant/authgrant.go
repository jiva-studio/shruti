// Package authgrant calls the auth service's internal subscription-grant
// endpoint. Billing never talks to RevenueCat — granting PRO is the auth
// service's job; billing only says who to grant and for how long.
package authgrant

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

// errNotConfigured is returned when the internal API token is unset; the
// order stays at `verified` for the reconcile loop to retry once the secret is
// wired.
var errNotConfigured = errors.New("authgrant: internal API token not configured")

// Client implements ports.SubscriptionGranter over the auth service's
// internal HTTP API.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *Client) Configured() bool { return c.token != "" }

type grantRequest struct {
	UserID   string `json:"userId"`
	Duration string `json:"duration"`
	GrantKey string `json:"grantKey,omitempty"`
}

// Grant calls POST {baseURL}/internal/subscription/grant. duration is the plan
// ("monthly"/"yearly"); grantKey (the billing order id) idempotency-keys the
// grant so a re-drive after a lost response doesn't extend the subscription
// twice. A non-nil error means the grant did not land.
func (c *Client) Grant(ctx context.Context, userID, duration, grantKey string) error {
	if !c.Configured() {
		return errNotConfigured
	}
	buf, err := json.Marshal(grantRequest{UserID: userID, Duration: duration, GrantKey: grantKey})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/internal/subscription/grant", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("authgrant: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 256))
		if err != nil {
			return fmt.Errorf("authgrant: grant status=%d, body unreadable: %w", resp.StatusCode, err)
		}
		return fmt.Errorf("authgrant: grant status=%d body=%s", resp.StatusCode, string(body))
	}
	return nil
}
