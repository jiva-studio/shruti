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
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const defaultBaseURL = "https://api.revenuecat.com/v1"

// Sentinel errors returned by GetSubscriber. Callers fan out on these
// with `errors.Is` (sentinels) or `errors.As` (typed values that carry
// extra context, like Retry-After).
//
// Classification:
//   - 404            → ErrSubscriberNotFound (soft success, RC creates
//                      subscribers lazily on first event)
//   - 401, 403       → ErrPermanent (wrapped via fmt.Errorf %w) — API key
//                      invalid or revoked, retrying won't help
//   - 429            → *RateLimitError (wraps ErrRateLimited) carrying
//                      the Retry-After header value, if any
//   - other 4xx      → ErrPermanent (we don't know what RC means by them
//                      but they aren't going to resolve themselves)
//   - 5xx, network   → plain error (retryable; existing webhook /
//                      reconcile retry budgets cover these)
var (
	ErrSubscriberNotFound = errors.New("rcclient: subscriber not found")
	ErrPermanent          = errors.New("rcclient: permanent failure")
	ErrRateLimited        = errors.New("rcclient: rate limited")
)

// RateLimitError is the typed form of ErrRateLimited. Callers can
// `errors.As(err, &re)` to read RetryAfter for honest backoff. Wraps
// ErrRateLimited so `errors.Is(err, ErrRateLimited)` works too.
type RateLimitError struct {
	RetryAfter time.Duration // 0 if RC didn't supply a Retry-After header
	Status     int
}

func (e *RateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("rcclient: rate limited (status=%d, retry_after=%s)", e.Status, e.RetryAfter)
	}
	return fmt.Sprintf("rcclient: rate limited (status=%d)", e.Status)
}

func (e *RateLimitError) Unwrap() error { return ErrRateLimited }

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
// `GET /subscribers/{id}`. We only care about the subscriber object and
// its entitlements; everything else (offerings, products,
// non-subscriptions) gets dropped by the JSON decoder.
//
// Subscriber is a pointer so a missing or null `subscriber` key
// surfaces as nil at the consumer (rather than a zero struct that
// looks superficially "OK"). The consumer treats nil Subscriber as a
// malformed body and falls back to free-tier.
type SubscriberResponse struct {
	Subscriber *Subscriber `json:"subscriber"`
}

// Subscriber is the inner `subscriber` object. OriginalAppUserID is
// required — RC always returns it for any non-404 success — so it
// stays a non-pointer. Entitlements is the canonical activity map but
// may be omitted on brand-new subscribers; the consumer treats nil as
// "no entitlements" (free).
type Subscriber struct {
	OriginalAppUserID string                 `json:"original_app_user_id"`
	Entitlements      map[string]Entitlement `json:"entitlements"`
}

// Entitlement is one slot of `subscriber.entitlements`. RC returns the
// entitlement here regardless of state; the consumer filters by
// `ExpiresDate > now()`. ExpiresDate is nullable for lifetime
// purchases — treat null (or the zero time, which RC has been observed
// to emit on synthetic test payloads) as "never expires", which still
// maps to active. PurchaseDate and ProductIdentifier are optional in
// the shape we care about, hence pointers — that way the consumer can
// distinguish "field omitted" from "empty string / zero time", which
// matters when we add corpus auditing later.
type Entitlement struct {
	ExpiresDate       *time.Time `json:"expires_date"`
	PurchaseDate      *time.Time `json:"purchase_date"`
	ProductIdentifier *string    `json:"product_identifier"`
	PeriodType        *string    `json:"period_type"`
}

// GetSubscriber fetches the current state for an RC app_user_id. The
// caller treats ErrSubscriberNotFound (404) as a soft success — RC
// creates the subscriber lazily on first event, so a webhook can race
// ahead. Permanent errors (401/403) come back as ErrPermanent so the
// webhook handler can mark the event processed and the reconcile cron
// can skip the user; 429 comes back as *RateLimitError carrying the
// Retry-After header.
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

	switch {
	case resp.StatusCode == http.StatusNotFound:
		// 404 is the only 4xx with a defined non-error meaning: RC
		// hasn't seen this app_user_id yet. Return an empty body so the
		// caller writes `tier=free` via the same path as a regular
		// "no active entitlements" response.
		return &SubscriberResponse{}, ErrSubscriberNotFound

	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// 401/403 — API key is misconfigured, revoked, or scoped wrong.
		// Retrying won't fix it; surface as ErrPermanent so the webhook
		// handler can stop RC's retry loop and the reconcile cron can
		// skip affected users.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("%w: status=%d body=%s", ErrPermanent,
			resp.StatusCode, sanitizeBody(body))

	case resp.StatusCode == http.StatusTooManyRequests:
		// 429 — RC throttle. Honour Retry-After if present (RC sends it
		// as seconds-integer per their docs). Caller decides whether to
		// retry inline or back off the whole cron tick.
		retry := parseRetryAfter(resp.Header.Get("Retry-After"))
		return nil, &RateLimitError{Status: resp.StatusCode, RetryAfter: retry}

	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		// Any other 4xx — unexpected from RC, but not retryable on its
		// own. Bundle into ErrPermanent so it surfaces the same way as
		// 401/403 (stop retries, log loudly).
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("%w: status=%d body=%s", ErrPermanent,
			resp.StatusCode, sanitizeBody(body))

	case resp.StatusCode >= 500:
		// 5xx → plain error, retryable. RC's webhook retries + our
		// reconcile cron eventually pick the user back up.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("rcclient: %s: %s", resp.Status, sanitizeBody(body))
	}

	var out SubscriberResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("rcclient: decode: %w", err)
	}
	return &out, nil
}

// parseRetryAfter accepts the integer-seconds form of the Retry-After
// header. RC always sends seconds; HTTP-date form is permitted by the
// spec but we don't see it from RC in practice. Returns 0 on parse
// failure — caller falls back to its own default backoff.
func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0
	}
	return time.Duration(n) * time.Second
}

// sanitizeBody trims whitespace and collapses anything beyond the first
// line — RC error bodies are short JSON like `{"code":7224,"message":
// "Invalid API key"}`, no need to log multi-line dumps that might carry
// transient identifiers.
func sanitizeBody(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}
