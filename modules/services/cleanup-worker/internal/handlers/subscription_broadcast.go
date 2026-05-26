package handlers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// RemoteRegion identifies one destination of the cross-region fan-out.
// ID is used purely for log lines and self-echo suppression; BaseURL is
// the scheme+host prefix that gets concatenated with
// /internal/subscription/apply to form the delivery target.
type RemoteRegion struct {
	ID      string
	BaseURL string
}

// SubscriptionBroadcastHandler delivers an RC subscriber-state snapshot
// to every remote region configured via REMOTE_REGIONS. Each delivery
// is an HMAC-authenticated POST to that region's
// /internal/subscription/apply. The handler returns nil only when ALL
// configured remote regions returned 2xx; any 5xx or network error keeps
// the outbox row pending (the outer worker loop retries with backoff per
// the dead-letter policy).
//
// 200 OK with {matched: false} from a remote is a successful delivery:
// the snapshot reached the destination; that region just doesn't own
// the app_user_id locally. Aggregated as "delivered" for the outbox row.
//
// Self-echo: if the source region (the one that produced the broadcast
// outbox row) appears in RemoteRegions, that entry is skipped — the
// originator already applied locally before writing the outbox row.
type SubscriptionBroadcastHandler struct {
	// Client is the HTTP client used for every delivery. Caller is
	// responsible for setting sensible timeouts.
	Client *http.Client
	// Secret is the shared HMAC key (LECTORIUM_INTERNAL_SECRET). Must
	// match the value the destination auth service expects.
	Secret string
	// RemoteRegions is the list of every other region the broadcast must
	// reach. Empty list → no-op success (single-region deployment).
	RemoteRegions []RemoteRegion
}

// subscriptionBroadcastPayload mirrors the JSON shape auth's
// service.ApplyRCSubscriberState writes into app.outbox.payload for
// event_type='subscription.broadcast'. Keep field tags in lockstep with
// the receiver (auth/internal/handler/internal_subscription.go's
// subscriptionApplyBody) so a payload round-trips unchanged.
type subscriptionBroadcastPayload struct {
	EventID       string `json:"event_id"`
	AppUserID     string `json:"app_user_id"`
	Tier          string `json:"tier"`
	TierExpiresAt *int64 `json:"tier_expires_at,omitempty"`
	SourceRegion  string `json:"source_region"`
}

// Handle implements the Handler contract. Return value semantics match
// the outbox retry loop: nil = mark processed; non-nil = leave row
// pending and retry. We return the first per-region error encountered
// but always attempt every region — that way one Russia outage doesn't
// silently delay deliveries to other configured regions.
func (h *SubscriptionBroadcastHandler) Handle(ctx context.Context, payload []byte) error {
	if len(h.RemoteRegions) == 0 {
		// Single-region deployment (Cloud Provider-only today). Nothing to
		// fan out; mark the outbox row processed so it doesn't pile up.
		return nil
	}
	var p subscriptionBroadcastPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		// Malformed payload is a producer bug that won't fix itself on
		// retry. Log and treat as processed to avoid an infinite loop —
		// the row stays in the DB for forensic review under the
		// configured retention window.
		slog.ErrorContext(ctx, "broadcast_payload_parse_failed",
			slog.String("err", err.Error()),
		)
		return nil
	}

	body, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("broadcast marshal: %w", err)
	}
	mac := hmac.New(sha256.New, []byte(h.Secret))
	mac.Write(body)
	hexMac := hex.EncodeToString(mac.Sum(nil))

	var firstErr error
	for _, r := range h.RemoteRegions {
		if r.ID == p.SourceRegion {
			// Don't echo back to the originating region — it already
			// applied the snapshot locally before writing the outbox row.
			continue
		}
		url := strings.TrimRight(r.BaseURL, "/") + "/internal/subscription/apply"
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("region %s: build request: %w", r.ID, err)
			}
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Lectorium-HMAC", hexMac)

		resp, err := h.Client.Do(req)
		if err != nil {
			slog.WarnContext(ctx, "broadcast_delivery_failed",
				slog.String("region", r.ID),
				slog.String("url", url),
				slog.String("err", err.Error()),
			)
			if firstErr == nil {
				firstErr = fmt.Errorf("region %s: %w", r.ID, err)
			}
			continue
		}
		// Drain a bounded slice of the body for log context, then close
		// so the connection can be reused.
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			slog.WarnContext(ctx, "broadcast_remote_non2xx",
				slog.String("region", r.ID),
				slog.Int("status", resp.StatusCode),
				slog.String("body", string(respBody)),
			)
			if firstErr == nil {
				firstErr = fmt.Errorf("region %s: status %d", r.ID, resp.StatusCode)
			}
			continue
		}
		slog.InfoContext(ctx, "broadcast_delivered",
			slog.String("region", r.ID),
			slog.String("event_id", p.EventID),
			slog.String("app_user_id", p.AppUserID),
		)
	}
	return firstErr
}

// SubscriptionBroadcast returns a Handler bound to h. Wired by main.go
// alongside the other event_type → Handler registrations. The closure
// indirection lets the registry store a uniform Handler signature while
// the handler keeps its own state (client, secret, remote list).
func SubscriptionBroadcast(h *SubscriptionBroadcastHandler) Handler {
	return func(ctx context.Context, evt Event) error {
		return h.Handle(ctx, evt.Payload)
	}
}
