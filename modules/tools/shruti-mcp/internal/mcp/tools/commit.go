package tools

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

func RegisterTrackValidate(s *server.MCPServer, deps Deps) {
	const kind = "track.validate"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Read-only: check whether a track has all required fields for catalog commit. Returns {ok, missing[], invalid[]}."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		tid, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		id, err := track.NewID(tid)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		// commit.UseCase has no validate-only entry point, so this calls Run,
		// which also writes the catalog when validation passes.
		res, err := deps.Commit.Run(ctx, id, lang)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), map[string]any{"result": res}), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func RegisterTrackCommit(s *server.MCPServer, deps Deps) {
	const kind = "track.commit"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Validate + write the track to catalog/current.db. On any missing/invalid field returns {ok:false, missing, invalid} and leaves stage=failed."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		tid, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		id, err := track.NewID(tid)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		res, err := deps.Commit.Run(ctx, id, lang)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}
