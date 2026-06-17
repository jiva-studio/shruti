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

	"github.com/akdasa-studios/shruti/modules/tools/denoiser-mcp/internal/client"
)

// JobClient is the slice of *client.Client the tools depend on. An interface so
// tool tests can inject mocks.
type JobClient interface {
	CreateJob(ctx context.Context, req client.CreateJobRequest) (*client.CreateJobResponse, error)
	CreateBatch(ctx context.Context, req client.BatchRequest) (*client.BatchResponse, error)
	ListObjects(ctx context.Context, req client.ListObjectsRequest) (*client.ListObjectsResponse, error)
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
	registerDenoiseBatch(s, p)
	registerListObjects(s, p)
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
		mcp.WithString("strategy",
			mcp.Description("Cleaning strategy: deepfilternet (default) | afftdn | rnnoise | rnnoise-mix | afftdn-rnnoise-mix.")),
		mcp.WithNumber("nr",
			mcp.Description("afftdn: noise reduction in dB, higher = more aggressive. Default 12.")),
		mcp.WithNumber("nf",
			mcp.Description("afftdn: noise floor in dB. Default -25.")),
		mcp.WithNumber("mix_min",
			mcp.Description("rnnoise-mix: original ratio in pauses (0-1). Default 0.10.")),
		mcp.WithNumber("mix_max",
			mcp.Description("rnnoise-mix: original ratio on voice (0-1). Default 0.25.")),
		mcp.WithString("plan_json",
			mcp.Description("Splice plan (overrides strategy): JSON "+
				"{\"segments\":[{\"start_ms\":0,\"end_ms\":275000,\"strategy\":\"afftdn\"},"+
				"{\"start_ms\":275000,\"strategy\":\"deepfilternet\"}],\"crossfade_ms\":120}. "+
				"Each segment is cleaned with its own strategy (afftdn over kirtan, "+
				"deepfilternet over speech); segments must form a contiguous partition; "+
				"loudness is applied once over the whole.")),
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

		params := paramsFromReq(req)
		if pj := strings.TrimSpace(req.GetString("plan_json", "")); pj != "" {
			if err := applyPlanJSON(&params, pj); err != nil {
				return mcp.NewToolResultError(err.Error()), nil
			}
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

// applyPlanJSON parses a splice-plan JSON string and folds it into params,
// overriding the single-strategy fields. Defaults crossfade to 120 ms.
func applyPlanJSON(params *client.DenoiseParams, planJSON string) error {
	var plan struct {
		Segments    []client.PlanSegment `json:"segments"`
		CrossfadeMs *int                 `json:"crossfade_ms"`
	}
	if err := json.Unmarshal([]byte(planJSON), &plan); err != nil {
		return fmt.Errorf("plan_json: %w", err)
	}
	if len(plan.Segments) == 0 {
		return errors.New("plan_json has no segments")
	}
	params.Segments = plan.Segments
	if plan.CrossfadeMs != nil {
		params.CrossfadeMs = *plan.CrossfadeMs
	} else {
		params.CrossfadeMs = 120
	}
	return nil
}

func paramsFromReq(req mcp.CallToolRequest) client.DenoiseParams {
	return client.DenoiseParams{
		Strategy: req.GetString("strategy", "afftdn"),
		NR:       req.GetFloat("nr", 12),
		NF:       req.GetFloat("nf", -25),
		MixMin:   req.GetFloat("mix_min", 0.10),
		MixMax:   req.GetFloat("mix_max", 0.25),
	}
}

// --- denoise_batch ---

func registerDenoiseBatch(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("denoise_batch",
		mcp.WithDescription(
			"Queue MANY denoise jobs in one call (hundreds/thousands). Non-blocking: "+
				"returns the created job ids immediately; the remote service chews through them "+
				"with its worker pool. Watch progress with health (queued/running/done/failed) "+
				"or list_jobs.\n\n"+
				"Two modes:\n"+
				"  • enumerate (default): set source_prefix — the service lists that prefix in "+
				"the source bucket, presigns each object, and submits one job per file. Outputs "+
				"go to dest_prefix, mirroring the source layout.\n"+
				"  • explicit: pass items_json = JSON array of {\"source_url\",\"dest_key\"}.\n\n"+
				"Uses the current S3 config (set_s3_config) for both listing the source and "+
				"uploading results, unless overridden."),
		mcp.WithString("source_prefix",
			mcp.Description("Enumerate mode: key prefix to list in the source bucket (e.g. 'raw/').")),
		mcp.WithString("source_bucket",
			mcp.Description("Source bucket to enumerate (default: S3 config bucket).")),
		mcp.WithString("dest_prefix",
			mcp.Description("Output key prefix (default 'clean/'). Source-relative paths are appended.")),
		mcp.WithString("dest_bucket",
			mcp.Description("Override destination bucket (default: S3 config bucket).")),
		mcp.WithString("items_json",
			mcp.Description("Explicit mode: JSON array of {\"source_url\",\"dest_key\"[,\"filename\"]}.")),
		mcp.WithNumber("limit", mcp.Description("Enumerate mode: max objects to submit. Default 100000.")),
		mcp.WithNumber("presign_expiry_s",
			mcp.Description("Enumerate mode: presigned source-URL TTL in seconds. Default 86400.")),
		mcp.WithString("strategy", mcp.Description("Cleaning strategy: deepfilternet (default) | afftdn | rnnoise | rnnoise-mix | afftdn-rnnoise-mix.")),
		mcp.WithNumber("nr", mcp.Description("afftdn: noise reduction dB. Default 12.")),
		mcp.WithNumber("nf", mcp.Description("afftdn: noise floor dB. Default -25.")),
		mcp.WithNumber("mix_min", mcp.Description("rnnoise-mix: original ratio in pauses. Default 0.10.")),
		mcp.WithNumber("mix_max", mcp.Description("rnnoise-mix: original ratio on voice. Default 0.25.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		cfg := p.S3Config()
		if cfg.Bucket == "" {
			return mcp.NewToolResultError(
				"no S3 config set — call set_s3_config first (bucket + keys)"), nil
		}

		dest := cfg
		if b := strings.TrimSpace(req.GetString("dest_bucket", "")); b != "" {
			dest.Bucket = b
		}

		batch := client.BatchRequest{
			Dest:           dest,
			Params:         paramsFromReq(req),
			DestPrefix:     strings.TrimSpace(req.GetString("dest_prefix", "")),
			PresignExpiryS: int(req.GetFloat("presign_expiry_s", 0)),
			Limit:          int(req.GetFloat("limit", 0)),
		}

		itemsJSON := strings.TrimSpace(req.GetString("items_json", ""))
		sourcePrefix := strings.TrimSpace(req.GetString("source_prefix", ""))
		switch {
		case itemsJSON != "":
			var items []client.BatchItem
			if err := json.Unmarshal([]byte(itemsJSON), &items); err != nil {
				return mcp.NewToolResultError("items_json: " + err.Error()), nil
			}
			if len(items) == 0 {
				return mcp.NewToolResultError("items_json is empty"), nil
			}
			batch.Items = items
		case sourcePrefix != "" || req.GetString("source_bucket", "") != "":
			srcBucket := strings.TrimSpace(req.GetString("source_bucket", ""))
			if srcBucket == "" {
				srcBucket = cfg.Bucket
			}
			batch.Source = &client.S3Source{
				Bucket:          srcBucket,
				Prefix:          sourcePrefix,
				AccessKeyID:     cfg.AccessKeyID,
				SecretAccessKey: cfg.SecretAccessKey,
				Region:          cfg.Region,
				EndpointURL:     cfg.EndpointURL,
			}
		default:
			return mcp.NewToolResultError(
				"provide source_prefix (enumerate mode) or items_json (explicit mode)"), nil
		}

		out, err := p.Client().CreateBatch(ctx, batch)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		preview := out.JobIDs
		if len(preview) > 20 {
			preview = preview[:20]
		}
		body, _ := json.MarshalIndent(map[string]any{
			"count":                out.Count,
			"job_ids_preview":      preview,
			"note":                 "jobs queued; poll health or list_jobs for progress",
			"truncated_to_preview": len(out.JobIDs) > len(preview),
		}, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
}

// --- list_objects ---

func registerListObjects(s *server.MCPServer, p Provider) {
	tool := mcp.NewTool("list_objects",
		mcp.WithDescription(
			"List objects under a bucket/prefix using the current S3 config credentials. "+
				"Use to discover what's there before denoise_batch."),
		mcp.WithString("prefix", mcp.Description("Key prefix to list (e.g. 'raw/'). Empty = whole bucket.")),
		mcp.WithString("bucket", mcp.Description("Bucket to list (default: S3 config bucket).")),
		mcp.WithNumber("limit", mcp.Description("Max keys. Default 1000.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		cfg := p.S3Config()
		if cfg.Bucket == "" {
			return mcp.NewToolResultError("no S3 config set — call set_s3_config first"), nil
		}
		bucket := strings.TrimSpace(req.GetString("bucket", ""))
		if bucket == "" {
			bucket = cfg.Bucket
		}
		limit := int(req.GetFloat("limit", 1000))
		if limit <= 0 {
			limit = 1000
		}
		out, err := p.Client().ListObjects(ctx, client.ListObjectsRequest{
			Source: client.S3Source{
				Bucket:          bucket,
				Prefix:          strings.TrimSpace(req.GetString("prefix", "")),
				AccessKeyID:     cfg.AccessKeyID,
				SecretAccessKey: cfg.SecretAccessKey,
				Region:          cfg.Region,
				EndpointURL:     cfg.EndpointURL,
			},
			Limit: limit,
		})
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		body, _ := json.MarshalIndent(out, "", "  ")
		return mcp.NewToolResultText(string(body)), nil
	})
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
