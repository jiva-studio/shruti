package tools

import (
	"context"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// RegisterOutlineBatch exposes the half-price outline path as submit + collect.
// One request per lecture, results within 24 hours.
func RegisterOutlineBatch(s *server.MCPServer, deps Deps) {
	registerOutlineBatchSubmit(s, deps)
	registerOutlineBatchCollect(s, deps)
	registerOutlineBatchList(s, deps)
}

func registerOutlineBatchSubmit(s *server.MCPServer, deps Deps) {
	const kind = "outline.batch.submit"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Queue whole lectures for outline + description on the provider's "+
				"batch endpoint, which bills at half the live rate and finishes "+
				"within 24 hours. Returns the job name to pass to "+
				"outline.batch.collect. Use track.transcript.outline / "+
				"pipeline.run op=outline when the result is needed now."),
		mcp.WithString("track_ids", mcp.Required(),
			mcp.Description("Comma-separated track ids to submit.")),
		mcp.WithString("language", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, err := req.RequireString("track_ids")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		var ids []track.ID
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			id, err := track.NewID(part)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
			}
			ids = append(ids, id)
		}
		res, err := deps.Outline.SubmitBatch(ctx, ids, lang)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerOutlineBatchCollect(s *server.MCPServer, deps Deps) {
	const kind = "outline.batch.collect"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Turn a finished batch job into stored outlines: the coarse chapters "+
				"and description onto the catalog variant, the granular list as a "+
				"private artifact. Lectures the job dropped come back under "+
				"`missing` — resubmit those. Errors if the job is still running."),
		mcp.WithString("name", mcp.Required(),
			mcp.Description("Job name from outline.batch.submit, e.g. batches/abc123.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		name, err := req.RequireString("name")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		res, err := deps.Outline.CollectBatch(ctx, name)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerOutlineBatchList(s *server.MCPServer, deps Deps) {
	const kind = "outline.batch.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List submitted outline batch jobs, newest first, with the lectures each covers."))
	s.AddTool(tool, func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Outline.BatchJobs == nil {
			return envelope.Err(kind, envelope.CodeInternal, "outline batch path is not configured", nil), nil
		}
		recs, err := deps.Outline.BatchJobs.List()
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"jobs": recs, "count": len(recs)}), nil
	})
}
