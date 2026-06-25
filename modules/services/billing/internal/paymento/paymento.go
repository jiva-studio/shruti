// Package paymento is the REST client for the Paymento crypto gateway.
//
// Two calls matter: CreatePayment (POST /v1/payment/request) returns a token we
// redirect the customer to, and Verify (POST /v1/payment/verify) returns the
// authoritative order status. We ALWAYS Verify before fulfilling — the IPN is
// only a nudge, never trusted on its own.
package paymento

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// GatewayBase is where the customer is redirected with the token.
const GatewayBase = "https://app.paymento.io/gateway?token="

// ErrNotConfigured is returned when the API key is unset — the handler maps it
// to 503 so the service still boots without Paymento secrets.
var ErrNotConfigured = errors.New("paymento: API key not configured")

type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

func New(baseURL, apiKey string) *Client {
	if baseURL == "" {
		baseURL = "https://api.paymento.io"
	}
	return &Client{
		BaseURL: baseURL,
		APIKey:  apiKey,
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

// Configured reports whether the API key is present.
func (c *Client) Configured() bool { return c.APIKey != "" }

type createRequest struct {
	FiatAmount     string            `json:"fiatAmount"`
	FiatCurrency   string            `json:"fiatCurrency"`
	ReturnURL      string            `json:"ReturnUrl"`
	OrderID        string            `json:"orderId"`
	Speed          int               `json:"Speed"`
	AdditionalData map[string]string `json:"additionalData,omitempty"`
	EmailAddress   string            `json:"EmailAddress,omitempty"`
}

type createResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Body    string `json:"body"` // the token
}

// CreatePayment requests a payment and returns the gateway token (response
// field `body`).
func (c *Client) CreatePayment(ctx context.Context, fiatAmount, fiatCurrency, returnURL, orderID string, additional map[string]string, email string) (token string, err error) {
	if !c.Configured() {
		return "", ErrNotConfigured
	}
	reqBody := createRequest{
		FiatAmount:     fiatAmount,
		FiatCurrency:   fiatCurrency,
		ReturnURL:      returnURL,
		OrderID:        orderID,
		Speed:          1,
		AdditionalData: additional,
		EmailAddress:   email,
	}
	raw, err := c.do(ctx, "/v1/payment/request", reqBody, "text/plain")
	if err != nil {
		return "", err
	}
	var out createResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("paymento: decode create: %w", err)
	}
	if !out.Success || out.Body == "" {
		return "", fmt.Errorf("paymento: create failed: success=%v msg=%q", out.Success, out.Message)
	}
	return out.Body, nil
}

// GatewayURL is the redirect URL for a token.
func GatewayURL(token string) string { return GatewayBase + token }

// VerifyResult is the parsed verify response. Approved is true only when the
// gateway reports orderStatus == "Approve".
type VerifyResult struct {
	Approved    bool
	OrderStatus string
	PaymentID   string
}

type verifyRequest struct {
	Token string `json:"token"`
}

// Verify confirms a payment by token. Parsed defensively — Paymento's verify
// body shape has drifted between docs, so we pull orderStatus + payment id from
// a few likely locations (top level and a nested `body` object) and treat
// "Approve" (case-insensitive) as success.
func (c *Client) Verify(ctx context.Context, token string) (*VerifyResult, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	raw, err := c.do(ctx, "/v1/payment/verify", verifyRequest{Token: token}, "application/json")
	if err != nil {
		return nil, err
	}
	var top map[string]any
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, fmt.Errorf("paymento: decode verify: %w", err)
	}
	status := pickString(top, "orderStatus", "OrderStatus", "status", "Status")
	paymentID := pickString(top, "paymentId", "PaymentId", "paymentID", "payment_id")
	if body, ok := top["body"].(map[string]any); ok {
		if status == "" {
			status = pickString(body, "orderStatus", "OrderStatus", "status", "Status")
		}
		if paymentID == "" {
			paymentID = pickString(body, "paymentId", "PaymentId", "paymentID", "payment_id")
		}
	}
	return &VerifyResult{
		Approved:    equalFoldTrim(status, "Approve"),
		OrderStatus: status,
		PaymentID:   paymentID,
	}, nil
}

func (c *Client) do(ctx context.Context, path string, body any, accept string) ([]byte, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Api-key", c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", accept)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("paymento: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("paymento: status=%d body=%s", resp.StatusCode, truncate(raw, 256))
	}
	return raw, nil
}

func pickString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch t := v.(type) {
			case string:
				if t != "" {
					return t
				}
			case float64:
				return fmt.Sprintf("%v", t)
			}
		}
	}
	return ""
}

func equalFoldTrim(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), b)
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n])
	}
	return string(b)
}
