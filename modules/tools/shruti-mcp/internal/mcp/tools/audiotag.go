package tools

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

func RegisterTrackTagAudio(s *server.MCPServer, deps Deps) {
	const kind = "track.audio.tag"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Compose ID3 tags from the catalog (author, location, primary reference, kind tag, date, language, track_id) and write them into out/public/tracks/{id}/audio/original.mp3. Auto-invoked by track_commit; useful standalone after a track_set_metadata edit."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required(), mcp.Description("ISO-639 code matching a committed variant.")),
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
		res, err := deps.AudioTag.Run(ctx, id, lang)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}
