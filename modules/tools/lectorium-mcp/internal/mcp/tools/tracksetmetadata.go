package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/commit"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

func RegisterTrackSetMetadata(s *server.MCPServer, deps Deps) {
	const kind = "track.metadata.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Manually patch tracks + track_variants + track_references for one (track, language). Resets commit(lang) → pending so the next track_commit re-validates."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("author_id", mcp.Description("New author_id (optional).")),
		mcp.WithString("location_id", mcp.Description("New location_id (optional).")),
		mcp.WithString("date", mcp.Description("New date YYYY-MM-DD (optional).")),
		mcp.WithString("title", mcp.Description("New title (optional).")),
		mcp.WithArray("sources", mcp.Description("Replace track_references: [{source_id, tokens}, ...].")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		tid, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		id, err := track.NewId(tid)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}

		input := commit.SetTrackMetadataInput{TrackId: id, Language: lang}
		args := req.GetArguments()
		if v, ok := args["author_id"].(string); ok {
			input.AuthorID = &v
		}
		if v, ok := args["location_id"].(string); ok {
			input.LocationID = &v
		}
		if v, ok := args["date"].(string); ok {
			input.Date = &v
		}
		if v, ok := args["title"].(string); ok {
			input.Title = &v
		}
		if rawArr, ok := args["sources"].([]any); ok {
			refs := make([]catalog.TrackReference, 0, len(rawArr))
			for i, item := range rawArr {
				m, ok := item.(map[string]any)
				if !ok {
					return envelope.Err(kind, envelope.CodeInvalidArgument, fmt.Sprintf("sources[%d] must be {source_id, tokens}", i), nil), nil
				}
				ref := catalog.TrackReference{}
				if s, _ := m["source_id"].(string); s != "" {
					ref.SourceID = s
				}
				if s, _ := m["tokens"].(string); s != "" {
					ref.Tokens = s
				}
				refs = append(refs, ref)
			}
			input.Sources = &refs
		}

		if err := deps.SetTrackMetadata.Run(ctx, input); err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}
