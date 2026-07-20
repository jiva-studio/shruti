package transcriberservice

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jiva-studio/shruti/pipeline/transcript"
	"github.com/jiva-studio/shruti/pipeline/ports/transcriber"
)

// ProviderName is the registry key for this kind. Wired in
// cmd/shruti-mcp/main.go's `switch p.Kind` block.
const ProviderName = "transcriber-service"

// Config seeds the adapter at startup. Endpoint is the only required
// field — defaults are sensible for the LAN-local M-series box.
type Config struct {
	Endpoint    string
	PollFast    time.Duration
	PollSlow    time.Duration
	PollFastFor time.Duration
	MaxWait     time.Duration
	Cleanup     bool // delete the job on the service after a successful fetch
}

// Transcriber is the transcribe.Transcriber adapter that delegates to
// the remote transcriber-service. Holds the upstream client behind an
// atomic.Pointer so admin tools can flip the endpoint URL at runtime
// without rebuilding the registry entry — in-flight Transcribe calls
// keep the client they captured at entry and finish against the prior
// URL; subsequent calls observe the swap immediately.
type Transcriber struct {
	client      atomic.Pointer[Client]
	pollFast    time.Duration
	pollSlow    time.Duration
	pollFastFor time.Duration
	maxWait     time.Duration
	cleanup     bool
}

// New builds an adapter from Config, applying defaults for any
// zero-valued duration / behaviour knob.
func New(cfg Config) *Transcriber {
	if cfg.PollFast == 0 {
		cfg.PollFast = 2 * time.Second
	}
	if cfg.PollSlow == 0 {
		cfg.PollSlow = 5 * time.Second
	}
	if cfg.PollFastFor == 0 {
		cfg.PollFastFor = 60 * time.Second
	}
	if cfg.MaxWait == 0 {
		cfg.MaxWait = 60 * time.Minute
	}
	t := &Transcriber{
		pollFast:    cfg.PollFast,
		pollSlow:    cfg.PollSlow,
		pollFastFor: cfg.PollFastFor,
		maxWait:     cfg.MaxWait,
		cleanup:     cfg.Cleanup,
	}
	t.client.Store(newClient(cfg.Endpoint))
	return t
}

// Name implements transcriber.Transcriber.
func (t *Transcriber) Name() string { return ProviderName }

// Endpoint exposes the live upstream URL for sanitize-overlay so
// `admin_config get` reflects post-swap state, not the yaml value.
func (t *Transcriber) Endpoint() string {
	c := t.client.Load()
	if c == nil {
		return ""
	}
	return c.BaseURL
}

// SetEndpoint validates `raw` and atomically swaps the upstream client.
// Implements the EndpointSwapper interface checked by admin_config.
func (t *Transcriber) SetEndpoint(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return errors.New("empty URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("URL must be http:// or https://")
	}
	if u.Host == "" {
		return errors.New("URL must include a host")
	}
	t.client.Store(newClient(raw))
	return nil
}

// Transcribe satisfies transcriber.Transcriber. Captures the current
// client at entry so a mid-call SetEndpoint swap does not redirect this
// upload to a new host. Flow: Upload → poll → GetTranscript → segment
// → optional DeleteJob → return.
func (t *Transcriber) Transcribe(ctx context.Context, audioPath string, opts transcriber.Options) (transcript.Raw, error) {
	c := t.client.Load()
	if c == nil {
		return transcript.Raw{}, errors.New("transcriber-service: no upstream client configured")
	}

	jobID, err := c.Upload(ctx, audioPath, opts.Language)
	if err != nil {
		return transcript.Raw{}, fmt.Errorf("upload: %w", err)
	}

	job, err := t.waitDone(ctx, c, jobID)
	if err != nil {
		return transcript.Raw{}, err
	}
	if job.Status == StatusFailed {
		errMsg := job.Error
		if errMsg == "" {
			errMsg = "service reported failed"
		}
		return transcript.Raw{}, fmt.Errorf("job %s failed: %s", jobID, errMsg)
	}

	tr, err := c.GetTranscript(ctx, jobID)
	if err != nil {
		return transcript.Raw{}, fmt.Errorf("get transcript: %w", err)
	}

	segments := segmentWordTimings(tr.WordTimings)

	if t.cleanup {
		// Best-effort — never let a delete failure obscure a successful
		// transcription that's already in our hands.
		_ = c.DeleteJob(ctx, jobID)
	}

	// Provider tag is the upstream service kind, not the model. The
	// service today fronts Parakeet but could swap to Whisper-large-v3
	// behind the same HTTP shape — record what we know now.
	return transcript.Raw{
		Provider: ProviderName,
		Model:    tr.ModelVersion,
		Segments: segments,
	}, nil
}

// waitDone polls the service until the job is `done`/`failed`,
// respects ctx deadlines, and switches polling cadence after the fast
// window.
func (t *Transcriber) waitDone(ctx context.Context, c *Client, jobID string) (*Job, error) {
	deadline := time.Now().Add(t.maxWait)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	switchAt := time.Now().Add(t.pollFastFor)

	for {
		job, err := c.GetJob(ctx, jobID)
		if err != nil {
			return nil, fmt.Errorf("get job: %w", err)
		}
		if job.Status == StatusDone || job.Status == StatusFailed {
			return job, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("transcribe %s: timed out after %s (last status=%s)",
				jobID, t.maxWait, job.Status)
		}
		interval := t.pollSlow
		if time.Now().Before(switchAt) {
			interval = t.pollFast
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}

var _ transcriber.Transcriber = (*Transcriber)(nil)
