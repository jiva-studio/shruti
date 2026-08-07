// Package chatclient is a thin outbound HTTP client the cleanup-worker uses
// to tell the `chat` service to erase a deleted user's private library — the
// `chunk_meta` rows that granted them access to their own uploads, and the
// transcript chunks of uploads nobody owns any more.
//
// Deleting an account already purged its Langfuse traces (observability) and
// its synced profile data (profileclient). The chat side was nobody's job:
// three deleted accounts still had 27 indexed chunks of their uploads when
// this was written.
//
// Same shape as profileclient, deliberately: cleanup-worker never touches
// another service's database, only a network-internal POST. The one
// difference is the token — chat's internal routes sit behind the shared app
// token, so it travels in `X-App-Token`.
//
// An unconfigured client (empty base URL) is valid and PurgeLibrary becomes a
// logged no-op, so the outbox is never blocked in an environment where chat
// is not reachable.
package chatclient

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

const (
	httpTimeout = 10 * time.Second
	maxAttempts = 3
	retryDelay  = 250 * time.Millisecond
	purgePath   = "/internal/purge"
)

// Client posts purge requests to the chat service's internal endpoint.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// NewClientFromEnv reads CHAT_INTERNAL_URL (e.g. "http://chat:8000") and the
// shared APP_SHARED_TOKEN. Either being empty makes PurgeLibrary a no-op:
// an unreachable or unauthenticated chat must not wedge the outbox.
func NewClientFromEnv() *Client {
	return &Client{
		baseURL:    strings.TrimRight(os.Getenv("CHAT_INTERNAL_URL"), "/"),
		token:      os.Getenv("APP_SHARED_TOKEN"),
		httpClient: &http.Client{Timeout: httpTimeout},
	}
}

type purgeRequest struct {
	UserID string `json:"user_id"`
}

// PurgeLibrary asks chat to erase everything it holds for userID.
//
// Contract: POST {baseURL}/internal/purge with {"user_id": "<sub>"} and the
// app token. Success is any 2xx; 404 counts as success (nothing to purge).
// Anything else is retried in-call and then returned, so the user.deleted
// handler fails and the outbox re-runs it. The purge is idempotent on the
// chat side — a re-run deletes nothing and returns zeroes.
func (c *Client) PurgeLibrary(ctx context.Context, userID string) error {
	if c == nil || c.baseURL == "" || c.token == "" {
		slog.InfoContext(ctx, "chat_purge_skipped_unconfigured", slog.String("user_id", userID))
		return nil
	}
	if userID == "" {
		return fmt.Errorf("chat purge: empty user id")
	}

	body, err := json.Marshal(purgeRequest{UserID: userID})
	if err != nil {
		return fmt.Errorf("chat purge: marshal: %w", err)
	}
	url := c.baseURL + purgePath

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		lastErr = c.doPurge(ctx, url, body)
		if lastErr == nil {
			slog.InfoContext(ctx, "chat_purge_done", slog.String("user_id", userID))
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
	return fmt.Errorf("chat purge (%d attempts): %w", maxAttempts, lastErr)
}

func (c *Client) doPurge(ctx context.Context, url string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-App-Token", c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 == 2 || resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
}
