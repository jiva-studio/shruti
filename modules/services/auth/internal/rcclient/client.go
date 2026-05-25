// Package rcclient is the thin REST client for RevenueCat's
// `GET /v1/subscribers/{app_user_id}` endpoint. We call it after every
// webhook delivery instead of switching on event_type — RC recommends
// this pattern explicitly and it sidesteps the whole bag of nasties
// around event ordering, refund semantics, grace-period flags and
// payload-field churn between RC versions.
package rcclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const defaultBaseURL = "https://api.revenuecat.com/v1"

type Client struct {
	BaseURL string // override for tests
	APIKey  string
	HTTP    *http.Client
}

func New(apiKey string) *Client {
	return &Client{
		BaseURL: defaultBaseURL,
		APIKey:  apiKey,
		HTTP: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// SubscriberResponse is the trimmed-down shape we actually read from
// `GET /subscribers/{id}`. We only care about active entitlements;
// everything else (offerings, products, non-subscriptions) gets
// dropped by the JSON decoder.
type SubscriberResponse struct {
	Subscriber struct {
		Entitlements map[string]Entitlement `json:"entitlements"`
	} `json:"subscriber"`
}

// Entitlement is one slot of `subscriber.entitlements`. RC returns the
// entitlement here regardless of state; the consumer filters by
// `ExpiresDate > now()`. `ExpiresDate` is nullable for lifetime
// purchases — treat null as "never expires", which still maps to
// active.
type Entitlement struct {
	ExpiresDate     *time.Time `json:"expires_date"`
	PurchaseDate    *time.Time `json:"purchase_date"`
	ProductIdentifier string   `json:"product_identifier"`
}

// GetSubscriber fetches the current state for an RC app_user_id. The
// caller treats a 404 ("subscriber not found") as a soft success —
// RC creates the subscriber lazily on first event, so a webhook can
// race ahead. We surface it as a non-error empty response.
func (c *Client) GetSubscriber(ctx context.Context, appUserID string) (*SubscriberResponse, error) {
	if c.APIKey == "" {
		return nil, fmt.Errorf("rcclient: API key not configured")
	}
	u := c.BaseURL + "/subscribers/" + url.PathEscape(appUserID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Platform", "server")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rcclient: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return &SubscriberResponse{}, nil
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("rcclient: %s: %s", resp.Status, string(body))
	}

	var out SubscriberResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("rcclient: decode: %w", err)
	}
	return &out, nil
}
