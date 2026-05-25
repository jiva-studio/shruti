// Package observability provides best-effort hooks into the self-hosted
// Langfuse OSS instance. The cleanup-worker uses it to GDPR-purge a user's
// traces in response to a `user.deleted` event off app.outbox. Failures
// are surfaced to the caller so the row stays unprocessed and the next
// sweep retries; a separate ClickHouse TTL acts as the durability safety
// net regardless.
//
// Originally landed (and tested) in PR #604 inside the auth service. The
// service that *receives* the user.deleted event moved to cleanup-worker
// per the outbox/choreography pattern (PR #607 added app.outbox); the REST
// client is the same code, just relocated to the new owner.
package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"time"
)

// Tunables. Conservative defaults; Langfuse caps page size at 100.
const (
	pageSize     = 100
	deleteBatch  = 50
	httpTimeout  = 15 * time.Second
	maxPageWalks = 200 // ≤ 20 000 traces per user — defensive cap.
)

// LangfuseClient holds the resolved env config. A zero/unconfigured client is
// valid: PurgeUserTraces becomes a no-op that logs once.
type LangfuseClient struct {
	host       string
	publicKey  string
	secretKey  string
	httpClient *http.Client
}

// NewClientFromEnv reads LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY /
// LANGFUSE_SECRET_KEY off the process environment. Empty host is fine —
// PurgeUserTraces becomes a no-op (useful for local dev where Langfuse
// isn't running).
func NewClientFromEnv() *LangfuseClient {
	return &LangfuseClient{
		host:      os.Getenv("LANGFUSE_HOST"),
		publicKey: os.Getenv("LANGFUSE_PUBLIC_KEY"),
		secretKey: os.Getenv("LANGFUSE_SECRET_KEY"),
		httpClient: &http.Client{
			Timeout: httpTimeout,
		},
	}
}

// PurgeUserTraces deletes every Langfuse trace tagged with the given userId
// via Langfuse's public REST API.
//
// API reference: https://api.reference.langfuse.com/
//   - GET    /api/public/traces?userId=…&limit=…&page=…
//   - DELETE /api/public/traces  (body: {"traceIds": ["…"]})
//
// Idempotent: re-running against an already-purged user returns nil after
// a single empty GET. The cleanup-worker relies on this — handler failure
// leaves the outbox row unprocessed and the next sweep calls us again.
func (c *LangfuseClient) PurgeUserTraces(ctx context.Context, userID string) error {
	if c == nil || c.host == "" {
		slog.InfoContext(ctx, "langfuse_purge_skipped_unconfigured", slog.String("user_id", userID))
		return nil
	}
	if userID == "" {
		return fmt.Errorf("langfuse purge: empty user id")
	}

	ids, err := c.listTraceIDs(ctx, userID)
	if err != nil {
		return fmt.Errorf("list traces: %w", err)
	}
	if len(ids) == 0 {
		slog.InfoContext(ctx, "langfuse_purge_no_traces", slog.String("user_id", userID))
		return nil
	}

	for start := 0; start < len(ids); start += deleteBatch {
		end := start + deleteBatch
		if end > len(ids) {
			end = len(ids)
		}
		if err := c.deleteTraces(ctx, ids[start:end]); err != nil {
			return fmt.Errorf("delete batch [%d:%d]: %w", start, end, err)
		}
	}
	slog.InfoContext(ctx, "langfuse_purge_done",
		slog.String("user_id", userID),
		slog.Int("deleted", len(ids)),
	)
	return nil
}

func (c *LangfuseClient) listTraceIDs(ctx context.Context, userID string) ([]string, error) {
	var out []string
	for page := 1; page <= maxPageWalks; page++ {
		ids, err := c.fetchPage(ctx, userID, page)
		if err != nil {
			return nil, err
		}
		if len(ids) == 0 {
			break
		}
		out = append(out, ids...)
		if len(ids) < pageSize {
			break
		}
	}
	return out, nil
}

// tracesPage is a minimal subset of the Langfuse response — we only need the
// trace id. Everything else is ignored.
type tracesPage struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

func (c *LangfuseClient) fetchPage(ctx context.Context, userID string, page int) ([]string, error) {
	u, err := url.Parse(c.host + "/api/public/traces")
	if err != nil {
		return nil, fmt.Errorf("bad host: %w", err)
	}
	q := u.Query()
	q.Set("userId", userID)
	q.Set("limit", fmt.Sprintf("%d", pageSize))
	q.Set("page", fmt.Sprintf("%d", page))
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var p tracesPage
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	ids := make([]string, 0, len(p.Data))
	for _, t := range p.Data {
		if t.ID != "" {
			ids = append(ids, t.ID)
		}
	}
	return ids, nil
}

func (c *LangfuseClient) deleteTraces(ctx context.Context, ids []string) error {
	body, err := json.Marshal(map[string]any{"traceIds": ids})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		c.host+"/api/public/traces", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		buf, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(buf))
	}
	// Drain so the connection can be reused.
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

func (c *LangfuseClient) setAuth(req *http.Request) {
	if c.publicKey != "" || c.secretKey != "" {
		req.SetBasicAuth(c.publicKey, c.secretKey)
	}
}
