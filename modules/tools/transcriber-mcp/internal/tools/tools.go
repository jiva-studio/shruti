// Package tools registers MCP tools that wrap a transcriber-service REST client.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/transcriber-mcp/internal/client"
)

// JobClient is the slice of *client.Client we depend on. Defined as an
// interface so tool tests can inject mocks.
type JobClient interface {
	GetJob(ctx context.Context, jobID string) (*client.Job, error)
	ListJobs(ctx context.Context, status string, limit int) ([]*client.Job, error)
	GetTranscript(ctx context.Context, jobID string) (*client.Transcript, error)
	GetHealth(ctx context.Context) (*client.Health, error)
}

// Provider yields a JobClient on demand and lets admin tools (set_service_url,
// set_save_dir) swap mutable runtime config. Tools call the accessors at
// handler time, so long-running waits keep their captured snapshot and new
// calls observe the swap immediately.
type Provider interface {
	Client() JobClient
	URL() string
	SetURL(url string) error
	SaveDir() string
	SetSaveDir(dir string) error
}

// StaticProvider wraps a fixed JobClient + save-dir. Setters return errors.
type StaticProvider struct {
	C        JobClient
	URL_     string
	SaveDir_ string
}

func (s StaticProvider) Client() JobClient            { return s.C }
func (s StaticProvider) URL() string                  { return s.URL_ }
func (StaticProvider) SetURL(string) error            { return errors.New("upstream URL is not mutable") }
func (s StaticProvider) SaveDir() string              { return s.SaveDir_ }
func (StaticProvider) SetSaveDir(string) error        { return errors.New("save dir is not mutable") }

// Config tunes long-poll behaviour. Zero values fall back to sensible defaults.
type Config struct {
	PollFast    time.Duration // poll interval for the first PollFastWindow (default 2s)
	PollSlow    time.Duration // poll interval after PollFastWindow (default 5s)
	PollFastFor time.Duration // window for fast-poll (default 60s)
	MaxTimeout  time.Duration // upper bound for client-supplied timeout_s (default 3600s)
}

func (c Config) withDefaults() Config {
	if c.PollFast <= 0 {
		c.PollFast = 2 * time.Second
	}
	if c.PollSlow <= 0 {
		c.PollSlow = 5 * time.Second
	}
	if c.PollFastFor <= 0 {
		c.PollFastFor = 60 * time.Second
	}
	if c.MaxTimeout <= 0 {
		c.MaxTimeout = 3600 * time.Second
	}
	return c
}

// DefaultSaveDir returns the fallback save directory (~/.transcriber/transcripts).
func DefaultSaveDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".transcriber", "transcripts")
	}
	return "transcripts"
}

// RegisterAll attaches every transcriber-mcp tool to s using p as the upstream
// provider. Pass a StaticProvider for fixed-URL deployments, or your own
// Provider implementation for runtime URL changes via set_service_url.
func RegisterAll(s *server.MCPServer, p Provider, cfg Config) {
	cfg = cfg.withDefaults()
	registerTranscribeWait(s, p, cfg)
	registerGetTranscript(s, p)
	registerSaveTranscript(s, p)
	registerListJobs(s, p)
	registerGetServiceURL(s, p)
	registerSetServiceURL(s, p)
	registerGetSaveDir(s, p)
	registerSetSaveDir(s, p)
	registerHealth(s, p)
}

// --- transcribe_wait ---

func registerTranscribeWait(s *server.MCPServer, p Provider, cfg Config) {
	tool := mcp.NewTool("transcribe_wait",
		mcp.WithDescription(
			"Wait for a transcription job to finish and return its text + key metrics. "+
				"Long-polls transcriber-service. Use timeout_s=0 to peek at the current "+
				"status without blocking. The audio must already be uploaded via "+
				"`POST /jobs` to the transcriber-service REST endpoint."),
		mcp.WithString("job_id", mcp.Required(), mcp.Description("Job UUID returned by POST /jobs.")),
		mcp.WithNumber("timeout_s",
			mcp.Description("Max wall seconds to wait. Default 600. 0 = no wait. Capped at server max.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		jobID, err := req.RequireString("job_id")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		timeoutS := int(req.GetFloat("timeout_s", 600))
		if timeoutS < 0 {
			timeoutS = 0
		}
		max := int(cfg.MaxTimeout.Seconds())
		if timeoutS > max {
			timeoutS = max
		}

		out, err := waitForJob(ctx, p.Client(), jobID, time.Duration(timeoutS)*time.Second, cfg)
		if err != nil {
			if errors.Is(err, client.ErrNotFound) {
				return mcp.NewToolResultError(fmt.Sprintf("job %q not found", jobID)), nil
			}
			return mcp.NewToolResultError(err.Error()), nil
		}
		body, _ := json.MarshalIndent(out, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// transcribeWaitResult is a slimmed-down view returned to the agent: text and
// key metrics, but no per-word timings (use get_transcript for those).
type transcribeWaitResult struct {
	JobID      string  `json:"job_id"`
	Status     string  `json:"status"`
	Text       string  `json:"text,omitempty"`
	Confidence float64 `json:"confidence,omitempty"`
	DurationS  float64 `json:"duration_s,omitempty"`
	RTFx       float64 `json:"rtfx,omitempty"`
	Error      string  `json:"error,omitempty"`
	TimedOut   bool    `json:"timed_out,omitempty"`
}

func waitForJob(ctx context.Context, c JobClient, jobID string, total time.Duration, cfg Config) (*transcribeWaitResult, error) {
	deadline := time.Now().Add(total)
	startedAt := time.Now()

	check := func() (*transcribeWaitResult, bool, error) {
		j, err := c.GetJob(ctx, jobID)
		if err != nil {
			return nil, false, err
		}
		switch j.Status {
		case client.StatusDone:
			t, err := c.GetTranscript(ctx, jobID)
			if err != nil {
				// Done in metadata, but transcript file missing or unreadable.
				return &transcribeWaitResult{JobID: j.JobID, Status: string(j.Status),
					Confidence: j.Confidence, DurationS: j.DurationSeconds, RTFx: j.RTFx,
					Error: "transcript fetch failed: " + err.Error()}, true, nil
			}
			return &transcribeWaitResult{
				JobID: j.JobID, Status: string(j.Status), Text: t.Text,
				Confidence: j.Confidence, DurationS: j.DurationSeconds, RTFx: j.RTFx,
			}, true, nil
		case client.StatusFailed:
			return &transcribeWaitResult{
				JobID: j.JobID, Status: string(j.Status), Error: j.Error,
			}, true, nil
		default:
			return &transcribeWaitResult{JobID: j.JobID, Status: string(j.Status)}, false, nil
		}
	}

	// One immediate check covers timeout_s=0 cleanly.
	res, finished, err := check()
	if err != nil {
		return nil, err
	}
	if finished || total <= 0 {
		return res, nil
	}

	for {
		// Backoff: PollFast for first PollFastFor, then PollSlow.
		var step time.Duration
		if time.Since(startedAt) < cfg.PollFastFor {
			step = cfg.PollFast
		} else {
			step = cfg.PollSlow
		}
		// Don't sleep past the deadline.
		if rem := time.Until(deadline); rem < step {
			step = rem
		}
		if step <= 0 {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(step):
		}
		res, finished, err = check()
		if err != nil {
			return nil, err
		}
		if finished {
			return res, nil
		}
		if time.Now().After(deadline) {
			break
		}
	}
	res.TimedOut = true
	return res, nil
}

// --- get_transcript ---

func registerGetTranscript(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("get_transcript",
		mcp.WithDescription(
			"Fetch the full transcript JSON for a completed job, including per-word "+
				"timings (wordTimings). Returns 'not done' error if the job is still "+
				"running or queued. Use after transcribe_wait reports status=done."),
		mcp.WithString("job_id", mcp.Required(), mcp.Description("Job UUID.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		jobID, err := req.RequireString("job_id")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		t, err := p.Client().GetTranscript(ctx, jobID)
		if err != nil {
			switch {
			case errors.Is(err, client.ErrNotFound):
				return mcp.NewToolResultError(fmt.Sprintf("job %q not found", jobID)), nil
			case errors.Is(err, client.ErrConflict):
				return mcp.NewToolResultError("transcript not ready (job still queued/running/failed)"), nil
			default:
				return mcp.NewToolResultError(err.Error()), nil
			}
		}
		body, _ := json.MarshalIndent(t, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- save_transcript ---

func registerSaveTranscript(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("save_transcript",
		mcp.WithDescription(
			"Download the transcript for a completed job and write it to a local file "+
				"on the machine where this MCP server is running. Returns size + word count "+
				"only — does NOT echo the full text into the agent's context. Use this "+
				"instead of get_transcript when the agent doesn't need to read the text "+
				"itself (e.g. you just want the file on disk for downstream processing). "+
				"By default writes to <server save-dir>/<job_id>.<format>; pass `path` "+
				"to override (absolute = literal, relative = under save-dir)."),
		mcp.WithString("job_id", mcp.Required(),
			mcp.Description("Job UUID. Job must be in status=done.")),
		mcp.WithString("path",
			mcp.Description("Optional override of the destination. Absolute path = used as-is. "+
				"Relative path = resolved under the server's save-dir. Empty = default file "+
				"name <job_id>.<format> in save-dir. `~` is expanded. If the resolved path is "+
				"an existing directory, the file is named <job_id>.<format> inside it. "+
				"Parent directories are created automatically.")),
		mcp.WithString("format",
			mcp.Description("'json' (default — full transcript with word timings) or "+
				"'txt' (just the text body, one paragraph).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		jobID, err := req.RequireString("job_id")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		userPath := strings.TrimSpace(req.GetString("path", ""))
		format := strings.ToLower(strings.TrimSpace(req.GetString("format", "json")))
		if format == "" {
			format = "json"
		}
		if format != "json" && format != "txt" {
			return mcp.NewToolResultError("format must be 'json' or 'txt'"), nil
		}

		t, err := p.Client().GetTranscript(ctx, jobID)
		if err != nil {
			switch {
			case errors.Is(err, client.ErrNotFound):
				return mcp.NewToolResultError(fmt.Sprintf("job %q not found", jobID)), nil
			case errors.Is(err, client.ErrConflict):
				return mcp.NewToolResultError("transcript not ready (job still queued/running/failed)"), nil
			default:
				return mcp.NewToolResultError(err.Error()), nil
			}
		}

		dest, err := resolveSavePath(p.SaveDir(), userPath, jobID, format)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		var payload []byte
		if format == "txt" {
			payload = []byte(t.Text)
		} else {
			payload, err = json.MarshalIndent(t, "", "  ")
			if err != nil {
				return mcp.NewToolResultError(err.Error()), nil
			}
		}
		if err := os.WriteFile(dest, payload, 0o644); err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		body, _ := json.MarshalIndent(map[string]any{
			"path":          dest,
			"format":        format,
			"bytes_written": len(payload),
			"words":         len(t.WordTimings),
			"confidence":    t.Confidence,
			"duration_s":    t.DurationSeconds,
		}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// resolveSavePath turns user input + server SaveDir into a concrete file path.
//   - empty userPath  → SaveDir/<job_id>.<format>
//   - absolute path   → as-is (after ~ expansion)
//   - relative path   → joined under SaveDir
// If the resolved path points to an existing directory, the basename
// "<job_id>.<format>" is appended inside it.
func resolveSavePath(saveDir, userPath, jobID, format string) (string, error) {
	saveDir, err := expandHome(saveDir)
	if err != nil {
		return "", err
	}
	if userPath == "" {
		return filepath.Join(saveDir, jobID+"."+format), nil
	}
	expanded, err := expandHome(userPath)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(expanded) {
		expanded = filepath.Join(saveDir, expanded)
	}
	if info, statErr := os.Stat(expanded); statErr == nil && info.IsDir() {
		expanded = filepath.Join(expanded, jobID+"."+format)
	}
	return expanded, nil
}

func expandHome(p string) (string, error) {
	if !strings.HasPrefix(p, "~") {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if p == "~" {
		return home, nil
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:]), nil
	}
	// "~user/..." — leave as-is; UserHomeDir already gave us $HOME for current user.
	return p, nil
}

// --- list_jobs ---

func registerListJobs(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("list_jobs",
		mcp.WithDescription(
			"List recent transcription jobs. Optionally filter by status "+
				"(queued/running/done/failed). Returns metadata only — call get_transcript "+
				"for the actual text."),
		mcp.WithString("status",
			mcp.Description("Filter: queued | running | done | failed. Empty = all.")),
		mcp.WithNumber("limit",
			mcp.Description("Max rows. Default 50, max 1000.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		status := req.GetString("status", "")
		limit := int(req.GetFloat("limit", 50))
		if limit <= 0 {
			limit = 50
		}
		if limit > 1000 {
			limit = 1000
		}
		jobs, err := p.Client().ListJobs(ctx, status, limit)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		if jobs == nil {
			jobs = []*client.Job{}
		}
		body, _ := json.MarshalIndent(jobs, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- admin: get_service_url / set_service_url ---

func registerGetServiceURL(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("get_service_url",
		mcp.WithDescription(
			"Return the upstream transcriber-service URL this MCP server is currently "+
				"talking to."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		body, _ := json.MarshalIndent(map[string]string{"service_url": p.URL()}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- admin: get_save_dir / set_save_dir ---

func registerGetSaveDir(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("get_save_dir",
		mcp.WithDescription(
			"Return the current default save directory used by save_transcript when "+
				"no explicit `path` is given (or when `path` is relative)."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		body, _ := json.MarshalIndent(map[string]string{"save_dir": p.SaveDir()}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

func registerSetSaveDir(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("set_save_dir",
		mcp.WithDescription(
			"Change the default save directory for save_transcript at runtime. "+
				"In-flight save_transcript calls keep their captured snapshot; new calls "+
				"observe the swap. `~` is expanded. Returns the previous value."),
		mcp.WithString("dir", mcp.Required(),
			mcp.Description("New default save directory. Absolute or `~`-prefixed paths are accepted.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		dir, err := req.RequireString("dir")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		prev := p.SaveDir()
		if err := p.SetSaveDir(dir); err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		body, _ := json.MarshalIndent(map[string]string{
			"previous_save_dir": prev,
			"save_dir":          p.SaveDir(),
		}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- health ---

type healthResult struct {
	MCPOK       bool          `json:"mcp_ok"`
	UpstreamOK  bool          `json:"upstream_ok"`
	ServiceURL  string        `json:"service_url"`
	UpstreamErr string        `json:"upstream_error,omitempty"`
	Service     *client.Health `json:"service,omitempty"`
}

func registerHealth(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("health",
		mcp.WithDescription(
			"Probe both the MCP server (this) and the upstream transcriber-service. "+
				"Returns mcp_ok=true if the MCP server is responsive (always, since this "+
				"tool ran), upstream_ok=true if the service is reachable, and the service's "+
				"own /healthz payload (workers, queue depth, model_loaded, etc.) when "+
				"reachable. Use to verify the M4 stack is alive from a remote machine."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		res := healthResult{MCPOK: true, ServiceURL: p.URL()}
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		h, err := p.Client().GetHealth(probeCtx)
		if err != nil {
			res.UpstreamErr = err.Error()
		} else {
			res.UpstreamOK = true
			res.Service = h
		}
		body, _ := json.MarshalIndent(res, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

func registerSetServiceURL(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("set_service_url",
		mcp.WithDescription(
			"Point this MCP server at a different transcriber-service. New tool calls "+
				"will use the new URL; in-flight transcribe_wait calls finish against the "+
				"previous URL. Returns the previous URL."),
		mcp.WithString("url", mcp.Required(),
			mcp.Description("Base URL like http://host:port (no trailing slash required).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		url, err := req.RequireString("url")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		prev := p.URL()
		if err := p.SetURL(url); err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		body, _ := json.MarshalIndent(map[string]string{
			"previous_url": prev,
			"service_url":  p.URL(),
		}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}
