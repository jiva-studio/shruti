// Package revenuecat is the REST client for RevenueCat's
// `GET /v1/subscribers/{app_user_id}` and promotional-grant endpoints. The
// service refetches the subscriber after every webhook delivery instead of
// switching on event_type, which sidesteps event ordering, refund semantics,
// grace-period flags and payload churn between RevenueCat versions.
package revenuecat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
)

const defaultBaseURL = "https://api.revenuecat.com/v1"

// Failures are classified into the subscription package's errors:
//   - 404            → ErrSubscriberNotFound (soft success, with an empty
//     customer: RevenueCat creates subscribers lazily on first event)
//   - 401, 403       → subscription.ErrPermanent — API key invalid or revoked
//   - 429            → *RateLimitError carrying Retry-After
//   - other 4xx      → subscription.ErrPermanent
//   - 5xx, network   → plain error (retryable; the webhook and reconcile
//     retry budgets cover these)
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

// customerBody is the part of `GET /subscribers/{id}` the service reads;
// offerings, products and non-subscriptions are dropped by the decoder. A
// missing or null `subscriber` decodes to nil.
type customerBody struct {
	RequestDateMs int64           `json:"request_date_ms"`
	Subscriber    *subscriberBody `json:"subscriber"`
}

type subscriberBody struct {
	OriginalAppUserID string                     `json:"original_app_user_id"`
	Entitlements      map[string]entitlementBody `json:"entitlements"`
}

type entitlementBody struct {
	ExpiresDate       *time.Time `json:"expires_date"`
	PurchaseDate      *time.Time `json:"purchase_date"`
	ProductIdentifier *string    `json:"product_identifier"`
	PeriodType        *string    `json:"period_type"`
}

func (b customerBody) customer() *subscription.Customer {
	out := &subscription.Customer{RequestDateMs: b.RequestDateMs}
	if b.Subscriber == nil {
		return out
	}
	out.Subscriber = &subscription.Subscriber{OriginalAppUserID: b.Subscriber.OriginalAppUserID}
	if b.Subscriber.Entitlements != nil {
		out.Subscriber.Entitlements = make(map[string]subscription.Entitlement, len(b.Subscriber.Entitlements))
		for k, e := range b.Subscriber.Entitlements {
			out.Subscriber.Entitlements[k] = subscription.Entitlement(e)
		}
	}
	return out
}

// GetSubscriber fetches the current state for an RC app_user_id. The
// caller treats ErrSubscriberNotFound (404) as a soft success — RC
// creates the subscriber lazily on first event, so a webhook can race
// ahead. Permanent errors (401/403) come back as subscription.ErrPermanent so the
// webhook handler can mark the event processed and the reconcile cron
// can skip the user; 429 comes back as *RateLimitError carrying the
// Retry-After header.
func (c *Client) GetSubscriber(ctx context.Context, appUserID string) (*subscription.Customer, error) {
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
		return &subscription.Customer{}, subscription.ErrSubscriberNotFound

	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// 401/403 — API key is misconfigured, revoked, or scoped wrong.
		// Retrying won't fix it; surface as subscription.ErrPermanent so the webhook
		// handler can stop RC's retry loop and the reconcile cron can
		// skip affected users.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("%w: status=%d body=%s", subscription.ErrPermanent,
			resp.StatusCode, sanitizeBody(body))

	case resp.StatusCode == http.StatusTooManyRequests:
		// 429 — RC throttle. Honour Retry-After if present (RC sends it
		// as seconds-integer per their docs). Caller decides whether to
		// retry inline or back off the whole cron tick.
		retry := parseRetryAfter(resp.Header.Get("Retry-After"))
		return nil, &subscription.RateLimitError{Status: resp.StatusCode, RetryAfter: retry}

	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		// Any other 4xx — unexpected from RC, but not retryable on its
		// own. Bundle into subscription.ErrPermanent so it surfaces the same way as
		// 401/403 (stop retries, log loudly).
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("%w: status=%d body=%s", subscription.ErrPermanent,
			resp.StatusCode, sanitizeBody(body))

	case resp.StatusCode >= 500:
		// 5xx → plain error, retryable. RC's webhook retries + our
		// reconcile cron eventually pick the user back up.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, fmt.Errorf("rcclient: %s: %s", resp.Status, sanitizeBody(body))
	}

	var out customerBody
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("rcclient: decode: %w", err)
	}
	return out.customer(), nil
}

// GrantPromotional grants a RevenueCat *promotional* entitlement to
// appUserID via `POST /subscribers/{id}/entitlements/{entitlement}/promotional`.
// `endTimeMs` is the absolute UNIX-epoch-ms expiry for the entitlement.
// RC does NOT fire a webhook on a promotional grant, so the caller must
// refetch + apply the resulting state itself. The subscriber must already
// exist (a prior GET creates it) — granting an unknown id returns 404.
//
// Classification mirrors GetSubscriber:
//   - 2xx            → success
//   - 4xx except 429 → subscription.ErrPermanent (bad key / unknown entitlement / bad
//     duration — retrying won't help)
//   - 429            → *RateLimitError (wraps ErrRateLimited)
//   - 5xx, network   → plain error (transient, retryable)
func (c *Client) GrantPromotional(ctx context.Context, appUserID, entitlementID string, endTimeMs int64) error {
	if c.APIKey == "" {
		return fmt.Errorf("rcclient: API key not configured")
	}
	u := c.BaseURL + "/subscribers/" + url.PathEscape(appUserID) +
		"/entitlements/" + url.PathEscape(entitlementID) + "/promotional"
	// RC accepts an absolute `end_time_ms` (in addition to its duration
	// enum) and sets the entitlement to expire exactly then — re-granting
	// REPLACES the expiry (it does not stack), so the caller computes
	// max(now, current_expiry)+period to extend without losing time.
	payload, err := json.Marshal(map[string]int64{"end_time_ms": endTimeMs})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Platform", "server")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("rcclient: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil

	case resp.StatusCode == http.StatusTooManyRequests:
		retry := parseRetryAfter(resp.Header.Get("Retry-After"))
		return &subscription.RateLimitError{Status: resp.StatusCode, RetryAfter: retry}

	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		// Any non-429 4xx — bad key, unknown entitlement, malformed
		// duration. Not retryable; surface as subscription.ErrPermanent.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("%w: status=%d body=%s", subscription.ErrPermanent,
			resp.StatusCode, sanitizeBody(body))

	default:
		// 5xx → plain error, retryable.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("rcclient: %s: %s", resp.Status, sanitizeBody(body))
	}
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
