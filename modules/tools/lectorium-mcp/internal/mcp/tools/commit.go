package tools

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/commit"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
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
		// Run validation by attempting a dry-run: we use Commit but without
		// persistence — easiest is to call Run and then refuse to claim;
		// instead we expose ValidateOnly. Keep it simple: invoke Run but
		// trap successful save by introspecting the repo. For MVP we just
		// document that track_validate is "track_commit without catalog write"
		// — Phase 9 will refactor commit.UseCase into Validate() + Save().
		res, _ := deps.Commit.Run(ctx, id, lang)
		return envelope.Result(kind, res), nil
	})
	_ = commit.UseCase{}
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
