package tools

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/runregistry"
)

// RegisterRunsList wires runs_list — paginated snapshot of in-flight and
// recently-finished runs. Defaults: state=active+recent, limit=50.
func RegisterRunsList(s *server.MCPServer, deps Deps) {
	const kind = "runs.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"List recent async runs (pipeline_run, catalog_publish, "+
				"tracks_*_bulk, per-track tools called with async=true). "+
				"Defaults to active + most-recent terminal, capped at 50. "+
				"Filter by kind or state."),
		mcp.WithString("kind", mcp.Description("Optional filter: pipeline | publish | tag_audio_bulk | align_pdf_bulk | audio_normalize | metadata_extract | transcript_create | transcript_review | transcript_align_pdf | track_tag_audio | track_commit.")),
		mcp.WithString("state", mcp.Description("Optional filter: queued | running | done | failed | cancelled. Empty = active+recent.")),
		mcp.WithNumber("limit", mcp.Description("Cap (default 50, max 500).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runs == nil {
			return envelope.Err(kind, envelope.CodeInternal, "run registry not initialized", nil), nil
		}
		limit := int(req.GetFloat("limit", float64(runregistry.DefaultListLimit)))
		if limit > 500 {
			limit = 500
		}
		opts := runregistry.ListOptions{
			Kind:  run.Kind(req.GetString("kind", "")),
			State: run.State(req.GetString("state", "")),
			Limit: limit,
		}
		runs, err := deps.Runs.List(ctx, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, struct {
			Runs []run.Run `json:"runs"`
		}{runs}), nil
	})
}

// RegisterRunStatus wires run_status — full snapshot of one run.
func RegisterRunStatus(s *server.MCPServer, deps Deps) {
	const kind = "runs.status"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Snapshot of one async run by run_id."),
		mcp.WithString("run_id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runs == nil {
			return envelope.Err(kind, envelope.CodeInternal, "run registry not initialized", nil), nil
		}
		id, err := req.RequireString("run_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		r, err := deps.Runs.Get(ctx, id)
		if err != nil {
			if errors.Is(err, runregistry.ErrNotFound) {
				return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("run %s: not found", id), nil), nil
			}
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, r), nil
	})
}

// RegisterRunWait wires run_wait — long-poll until the run hits a
// terminal state or timeout. Replaces the old pipeline_wait + ad-hoc
// catalog_publish_status polling.
func RegisterRunWait(s *server.MCPServer, deps Deps) {
	const kind = "runs.wait"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Block until the named run reaches a terminal state "+
				"(done, failed, cancelled), or until timeout. Returns the "+
				"final run snapshot. timed_out=true distinguishes 'still "+
				"running' from a real terminal."),
		mcp.WithString("run_id", mcp.Required()),
		mcp.WithNumber("timeout_s", mcp.Description("Hard timeout in seconds (default 600).")),
		mcp.WithNumber("poll_interval_s", mcp.Description("Polling interval in seconds (default 3, min 1).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runs == nil {
			return envelope.Err(kind, envelope.CodeInternal, "run registry not initialized", nil), nil
		}
		id, err := req.RequireString("run_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		timeout := time.Duration(req.GetFloat("timeout_s", 600)) * time.Second
		interval := time.Duration(req.GetFloat("poll_interval_s", 3)) * time.Second
		if interval < time.Second {
			interval = time.Second
		}
		deadline := time.Now().Add(timeout)
		for {
			r, err := deps.Runs.Get(ctx, id)
			if err != nil {
				if errors.Is(err, runregistry.ErrNotFound) {
					return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("run %s: not found", id), nil), nil
				}
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			if r.State.IsTerminal() {
				return envelope.Result(kind, struct {
					Run      run.Run `json:"run"`
					TimedOut bool    `json:"timed_out"`
				}{r, false}), nil
			}
			if time.Now().After(deadline) {
				return envelope.Result(kind, struct {
					Run      run.Run `json:"run"`
					TimedOut bool    `json:"timed_out"`
				}{r, true}), nil
			}
			select {
			case <-ctx.Done():
				return envelope.Err(kind, envelope.CodeInternal, ctx.Err().Error(), nil), nil
			case <-time.After(interval):
			}
		}
	})
}

// RegisterRunCancel wires run_cancel — request cancellation. Idempotent
// on already-terminal runs.
func RegisterRunCancel(s *server.MCPServer, deps Deps) {
	const kind = "runs.cancel"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Cancel a running async run. v1 scope: cancels queued runs "+
				"immediately and signals ctx.Done() to running ones — already-"+
				"running subprocesses (whisper, ffmpeg) finish their current "+
				"step before exiting. Idempotent on terminal runs."),
		mcp.WithString("run_id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runs == nil {
			return envelope.Err(kind, envelope.CodeInternal, "run registry not initialized", nil), nil
		}
		id, err := req.RequireString("run_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.Runs.Cancel(ctx, id); err != nil {
			if errors.Is(err, runregistry.ErrNotFound) {
				return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("run %s: not found", id), nil), nil
			}
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, struct {
			Cancelled bool   `json:"cancelled"`
			RunId     string `json:"run_id"`
		}{true, id}), nil
	})
}
