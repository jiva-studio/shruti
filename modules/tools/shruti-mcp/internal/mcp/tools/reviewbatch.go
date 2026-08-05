package tools

import (
	"context"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/review"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// RegisterReviewBatch exposes the slow half-price review path as an explicit
// pair: submit queues the work, collect turns it into transcripts. Everything
// the job fails to deliver is reviewed live during collect, so a dropped chunk
// costs a few cents rather than another 24-hour window.
func RegisterReviewBatch(s *server.MCPServer, deps Deps) {
	registerReviewBatchSubmit(s, deps)
	registerReviewBatchCollect(s, deps)
	registerReviewBatchList(s, deps)
}

func registerReviewBatchSubmit(s *server.MCPServer, deps Deps) {
	const kind = "review.batch.submit"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Queue whole lectures for review on the provider's batch endpoint, "+
				"which bills at half the live rate and finishes within 24 hours. "+
				"Returns the job name to pass to review.batch.collect. Use the "+
				"live path (track.transcript.review / pipeline.run only=reviewed) "+
				"when the result is needed now."),
		mcp.WithString("track_ids", mcp.Required(),
			mcp.Description("Comma-separated track ids to submit.")),
		mcp.WithString("language", mcp.Required()),
		mcp.WithNumber("chunk_size", mcp.Description("Segments per request. Default: review.chunk_size from config.")),
		mcp.WithNumber("overlap", mcp.Description("Overlap between chunks. Default: review.overlap from config.")),
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
		var ids []track.Id
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			id, err := track.NewId(part)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
			}
			ids = append(ids, id)
		}
		opts := review.Options{
			ChunkSize: int(req.GetFloat("chunk_size", 0)),
			Overlap:   int(req.GetFloat("overlap", 0)),
		}
		res, err := deps.Review.SubmitBatch(ctx, ids, lang, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerReviewBatchCollect(s *server.MCPServer, deps Deps) {
	const kind = "review.batch.collect"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Turn a finished batch job into reviewed transcripts. Replies are "+
				"stored as ordinary chunk artifacts, then the live review runs per "+
				"track and pays only for chunks the job dropped or failed. Errors if "+
				"the job is still running."),
		mcp.WithString("name", mcp.Required(),
			mcp.Description("Job name from review.batch.submit, e.g. batches/abc123.")),
		mcp.WithNumber("concurrency", mcp.Description("Live-review concurrency for the catch-up pass.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		name, err := req.RequireString("name")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		res, err := deps.Review.CollectBatch(ctx, name, review.Options{
			Concurrency: int(req.GetFloat("concurrency", 0)),
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerReviewBatchList(s *server.MCPServer, deps Deps) {
	const kind = "review.batch.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List submitted batch jobs, newest first, with the tracks each covers."))
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.ReviewBatchJobs == nil {
			return envelope.Err(kind, envelope.CodeInternal, "batch path is not configured", nil), nil
		}
		recs, err := deps.ReviewBatchJobs.List(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"jobs": recs, "count": len(recs)}), nil
	})
}
