// Package tools registers MCP tools that wrap a denoiser-service REST client.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/lectorium/modules/tools/denoiser-mcp/internal/client"
)

// JobClient is the slice of *client.Client the tools depend on. An interface so
// tool tests can inject mocks.
type JobClient interface {
	CreateJob(ctx context.Context, req client.CreateJobRequest) (*client.CreateJobResponse, error)
	GetJob(ctx context.Context, jobID string) (*client.Job, error)
	ListJobs(ctx context.Context, status string, limit int) ([]*client.Job, error)
	DeleteJob(ctx context.Context, jobID string) error
	GetHealth(ctx context.Context) (*client.Health, error)
}

// Provider yields a JobClient + mutable S3 config on demand. Admin tools
// (set_service_url, set_s3_config) swap them atomically; tools read at handler
// time so long-running waits keep their captured snapshot.
type Provider interface {
	Client() JobClient
	URL() string
	SetURL(url string) error
	S3Config() client.S3Dest
	SetS3Config(cfg client.S3Dest) error
}

// Config tunes long-poll behaviour. Zero values fall back to sensible defaults.
type Config struct {
	PollFast    time.Duration
	PollSlow    time.Duration
	PollFastFor time.Duration
	MaxTimeout  time.Duration
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

// RegisterAll attaches every denoiser-mcp tool to s.
func RegisterAll(s *server.MCPServer, p Provider, cfg Config) {
	cfg = cfg.withDefaults()
	registerDenoiseWait(s, p, cfg)
	registerGetJob(s, p)
	registerListJobs(s, p)
	registerDeleteJob(s, p)
	registerGetServiceURL(s, p)
	registerSetServiceURL(s, p)
	registerGetS3Config(s, p)
	registerSetS3Config(s, p)
	registerHealth(s, p)
}

// --- denoise_wait ---

func registerDenoiseWait(s *server.MCPServer, p Provider, cfg Config) {
	tool := mcp.NewTool("denoise_wait",
		mcp.WithDescription(
			"Queue a denoise job and wait for it to finish. The service downloads "+
				"`source_url` (e.g. a public S3 object), denoises it, and uploads the result "+
				"to `dest_key` in the bucket from the current S3 config (set_s3_config). "+
				"Returns the destination URL + timing metrics. Use timeout_s=0 to enqueue "+
				"and return the job_id immediately without waiting (poll later with get_job)."),
		mcp.WithString("source_url", mcp.Required(),
			mcp.Description("HTTP(S) URL of the input audio to denoise.")),
		mcp.WithString("dest_key", mcp.Required(),
			mcp.Description("Destination object key, e.g. 'clean/lecture.mp3'.")),
		mcp.WithString("bucket",
			mcp.Description("Override the destination bucket for this job (default: S3 config bucket).")),
		mcp.WithBoolean("noise_profile",
			mcp.Description("Apply spectral subtraction (slower, ~3x). Default false.")),
		mcp.WithBoolean("no_normalize",
			mcp.Description("Disable volume normalization. Default false (normalization on).")),
		mcp.WithNumber("mix_min",
			mcp.Description("%% original mixed back where NO voice (0-100). Default 0.")),
		mcp.WithNumber("mix_max",
			mcp.Description("%% original mixed back where voice present (0-100). Default 0.")),
		mcp.WithNumber("sample_rate",
			mcp.Description("Processing sample rate. Default 48000.")),
		mcp.WithNumber("timeout_s",
			mcp.Description("Max wall seconds to wait. Default 1800. 0 = enqueue and return now.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		sourceURL, err := req.RequireString("source_url")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		destKey, err := req.RequireString("dest_key")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		dest := p.S3Config()
		if dest.Bucket == "" {
			return mcp.NewToolResultError(
				"no S3 config set — call set_s3_config first (bucket + keys)"), nil
		}
		if b := strings.TrimSpace(req.GetString("bucket", "")); b != "" {
			dest.Bucket = b
		}
		dest.Key = destKey

		params := client.DenoiseParams{
			Normalize:    !req.GetBool("no_normalize", false),
			NoiseProfile: req.GetBool("noise_profile", false),
			MixMin:       req.GetFloat("mix_min", 0),
			MixMax:       req.GetFloat("mix_max", 0),
			SampleRate:   int(req.GetFloat("sample_rate", 48000)),
		}

		created, err := p.Client().CreateJob(ctx, client.CreateJobRequest{
			SourceURL: sourceURL, Dest: dest, Params: params,
		})
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}

		timeoutS := int(req.GetFloat("timeout_s", 1800))
		if timeoutS < 0 {
			timeoutS = 0
		}
		if max := int(cfg.MaxTimeout.Seconds()); timeoutS > max {
			timeoutS = max
		}

		out, err := waitForJob(ctx, p.Client(), created.JobID,
			time.Duration(timeoutS)*time.Second, cfg)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		body, _ := json.MarshalIndent(out, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

type denoiseResult struct {
	JobID     string  `json:"job_id"`
	Status    string  `json:"status"`
	DestURL   string  `json:"dest_url,omitempty"`
	DurationS float64 `json:"duration_s,omitempty"`
	ProcS     float64 `json:"processing_s,omitempty"`
	RTFx      float64 `json:"rtfx,omitempty"`
	Error     string  `json:"error,omitempty"`
	TimedOut  bool    `json:"timed_out,omitempty"`
}

func waitForJob(ctx context.Context, c JobClient, jobID string, total time.Duration, cfg Config) (*denoiseResult, error) {
	deadline := time.Now().Add(total)
	startedAt := time.Now()

	check := func() (*denoiseResult, bool, error) {
		j, err := c.GetJob(ctx, jobID)
		if err != nil {
			return nil, false, err
		}
		r := &denoiseResult{JobID: j.JobID, Status: string(j.Status)}
		switch j.Status {
		case client.StatusDone:
			r.DestURL = j.DestURL
			r.DurationS = j.DurationSeconds
			r.ProcS = j.ProcessingTimeSeconds
			r.RTFx = j.RTFx
			return r, true, nil
		case client.StatusFailed:
			r.Error = j.Error
			return r, true, nil
		default:
			return r, false, nil
		}
	}

	res, finished, err := check()
	if err != nil {
		return nil, err
	}
	if finished || total <= 0 {
		return res, nil
	}

	for {
		var step time.Duration
		if time.Since(startedAt) < cfg.PollFastFor {
			step = cfg.PollFast
		} else {
			step = cfg.PollSlow
		}
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

// --- get_job ---

func registerGetJob(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("get_job",
		mcp.WithDescription("Fetch one denoise job's metadata (status, dest_url, metrics, error)."),
		mcp.WithString("job_id", mcp.Required(), mcp.Description("Job id.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		jobID, err := req.RequireString("job_id")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		j, err := p.Client().GetJob(ctx, jobID)
		if err != nil {
			if errors.Is(err, client.ErrNotFound) {
				return mcp.NewToolResultError(fmt.Sprintf("job %q not found", jobID)), nil
			}
			return mcp.NewToolResultError(err.Error()), nil
		}
		body, _ := json.MarshalIndent(j, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- list_jobs ---

func registerListJobs(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("list_jobs",
		mcp.WithDescription("List recent denoise jobs. Optionally filter by status."),
		mcp.WithString("status", mcp.Description("queued | running | done | failed. Empty = all.")),
		mcp.WithNumber("limit", mcp.Description("Max rows. Default 50, max 1000.")),
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

// --- delete_job ---

func registerDeleteJob(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("delete_job",
		mcp.WithDescription("Remove a finished or failed job record from the service."),
		mcp.WithString("job_id", mcp.Required(), mcp.Description("Job id.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		jobID, err := req.RequireString("job_id")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		if err := p.Client().DeleteJob(ctx, jobID); err != nil {
			switch {
			case errors.Is(err, client.ErrNotFound):
				return mcp.NewToolResultError(fmt.Sprintf("job %q not found", jobID)), nil
			case errors.Is(err, client.ErrConflict):
				return mcp.NewToolResultError("cannot delete a running job"), nil
			default:
				return mcp.NewToolResultError(err.Error()), nil
			}
		}
		return mcp.NewToolResultText(fmt.Sprintf(`{"deleted":%q}`, jobID)), nil
	})
}

// --- admin: get/set_service_url ---

func registerGetServiceURL(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("get_service_url",
		mcp.WithDescription("Return the upstream denoiser-service URL this MCP server talks to."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		body, _ := json.MarshalIndent(map[string]string{"service_url": p.URL()}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

func registerSetServiceURL(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("set_service_url",
		mcp.WithDescription(
			"Point this MCP server at a different denoiser-service. New calls use the new "+
				"URL; in-flight denoise_wait calls finish against the previous URL. Returns the "+
				"previous URL."),
		mcp.WithString("url", mcp.Required(),
			mcp.Description("Base URL like http://host:port.")),
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
			"previous_url": prev, "service_url": p.URL(),
		}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- admin: get/set_s3_config ---

func registerGetS3Config(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("get_s3_config",
		mcp.WithDescription(
			"Return the current S3 upload config used for denoise destinations. The secret "+
				"access key is masked."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		cfg := p.S3Config()
		body, _ := json.MarshalIndent(map[string]any{
			"bucket":        cfg.Bucket,
			"region":        cfg.Region,
			"endpoint_url":  cfg.EndpointURL,
			"acl":           cfg.ACL,
			"access_key_id": maskKey(cfg.AccessKeyID),
			"secret_set":    cfg.SecretAccessKey != "",
		}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

func registerSetS3Config(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("set_s3_config",
		mcp.WithDescription(
			"Set the S3 upload credentials + destination defaults at runtime. These ride "+
				"with every denoise job (the service never persists them). In-flight jobs keep "+
				"their captured snapshot; new calls observe the swap. Input is read from a public "+
				"URL, so only the UPLOAD side needs keys."),
		mcp.WithString("bucket", mcp.Required(), mcp.Description("Default destination bucket.")),
		mcp.WithString("access_key_id", mcp.Required(), mcp.Description("S3 access key id.")),
		mcp.WithString("secret_access_key", mcp.Required(), mcp.Description("S3 secret access key.")),
		mcp.WithString("region", mcp.Description("Region, e.g. 'ru-central1' or 'us-east-1'.")),
		mcp.WithString("endpoint_url",
			mcp.Description("Custom endpoint for non-AWS S3 (e.g. https://storage.yandexcloud.net).")),
		mcp.WithString("acl", mcp.Description("Optional canned ACL, e.g. 'public-read'.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		bucket, err := req.RequireString("bucket")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		ak, err := req.RequireString("access_key_id")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		sk, err := req.RequireString("secret_access_key")
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		cfg := client.S3Dest{
			Bucket:          strings.TrimSpace(bucket),
			AccessKeyID:     strings.TrimSpace(ak),
			SecretAccessKey: strings.TrimSpace(sk),
			Region:          strings.TrimSpace(req.GetString("region", "")),
			EndpointURL:     strings.TrimSpace(req.GetString("endpoint_url", "")),
			ACL:             strings.TrimSpace(req.GetString("acl", "")),
		}
		if err := p.SetS3Config(cfg); err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		body, _ := json.MarshalIndent(map[string]any{
			"bucket":        cfg.Bucket,
			"region":        cfg.Region,
			"endpoint_url":  cfg.EndpointURL,
			"access_key_id": maskKey(cfg.AccessKeyID),
			"secret_set":    true,
		}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- health ---

type healthResult struct {
	MCPOK       bool           `json:"mcp_ok"`
	UpstreamOK  bool           `json:"upstream_ok"`
	ServiceURL  string         `json:"service_url"`
	UpstreamErr string         `json:"upstream_error,omitempty"`
	Service     *client.Health `json:"service,omitempty"`
}

func registerHealth(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("health",
		mcp.WithDescription(
			"Probe both the MCP server (this) and the upstream denoiser-service. Returns "+
				"the service's /healthz payload (workers, queue depth, denoiser_ready) when "+
				"reachable. Use to verify the remote denoise stack is alive."),
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

func maskKey(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		return "****"
	}
	return s[:4] + strings.Repeat("*", len(s)-4)
}
