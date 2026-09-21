// Package profileclient is a thin outbound HTTP client the cleanup-worker
// uses to tell the `profile` sync service to erase a deleted user's synced
// data (library, listening history, notes, chat).
//
// cleanup-worker never touches the profile database — it only makes a
// network-internal call to profile's `POST /internal/purge {user_id}`
// endpoint (container-to-container, never through the public edge, no JWT).
// profile then wipes every row it holds for that user in its own database.
// See docs/.../architecture/profile-sync.md, "Deletion".
//
// This mirrors the sibling observability.LangfuseClient outbound pattern:
// an unconfigured client (empty base URL) is valid and PurgeUser becomes a
// logged no-op, so the live outbox is never blocked before `profile` is
// actually deployed. Once PROFILE_INTERNAL_URL is set, a failed purge is
// surfaced to the caller so the user.deleted handler returns an error and
// the outbox row is retried on the next sweep. The purge itself is
// idempotent on the profile side, so a retried call is a no-op.
package profileclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// Tunables. Short, bounded work: a single small POST per user.
const (
	httpTimeout = 10 * time.Second
	maxAttempts = 3 // in-call retries on top of the outbox re-run
	retryDelay  = 250 * time.Millisecond
	purgePath   = "/internal/purge"
)

// Client posts purge requests to the profile service's internal endpoint.
// A zero/unconfigured client (empty baseURL) is valid: PurgeUser becomes a
// no-op that logs once, mirroring observability.LangfuseClient.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// NewClientFromEnv reads PROFILE_INTERNAL_URL off the process environment
// (e.g. "http://profile:8085"). Empty is fine — PurgeUser becomes a no-op,
// so a deploy where `profile` does not exist yet never blocks the outbox.
// The value is env-driven; no hostname is baked into the binary.
func NewClientFromEnv() *Client {
	return &Client{
		baseURL: strings.TrimRight(os.Getenv("PROFILE_INTERNAL_URL"), "/"),
		httpClient: &http.Client{
			Timeout: httpTimeout,
		},
	}
}

type purgeRequest struct {
	UserID string `json:"user_id"`
}

// PurgeUser asks the profile service to erase all synced data for userID.
//
// Contract: POST {baseURL}/internal/purge with body {"user_id": "<uuid>"}.
// Success is any 2xx; 404 is also treated as success (the user already has
// no data on profile — the purge is a no-op, and this keeps the caller
// idempotent). Any other status, or a transport error, is retried a few
// times in-call and then returned so the user.deleted handler fails and the
// outbox re-runs it later.
func (c *Client) PurgeUser(ctx context.Context, userID string) error {
	if c == nil || c.baseURL == "" {
		slog.InfoContext(ctx, "profile_purge_skipped_unconfigured", slog.String("user_id", userID))
		return nil
	}
	if userID == "" {
		return fmt.Errorf("profile purge: empty user id")
	}

	body, err := json.Marshal(purgeRequest{UserID: userID})
	if err != nil {
		return fmt.Errorf("profile purge: marshal: %w", err)
	}
	url := c.baseURL + purgePath

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		lastErr = c.doPurge(ctx, url, body)
		if lastErr == nil {
			slog.InfoContext(ctx, "profile_purge_done", slog.String("user_id", userID))
			return nil
		}
		if attempt < maxAttempts {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(retryDelay):
			}
		}
	}
	return fmt.Errorf("profile purge (%d attempts): %w", maxAttempts, lastErr)
}

// doPurge performs a single POST attempt. Returns nil on 2xx or 404.
func (c *Client) doPurge(ctx context.Context, url string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// 2xx = purged; 404 = nothing to purge (already idempotent no-op).
	if resp.StatusCode/100 == 2 || resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)) // drain for keep-alive
		return nil
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
}
