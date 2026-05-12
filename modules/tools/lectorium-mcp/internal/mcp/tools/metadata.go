package tools

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/extractmeta"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

func RegisterMetadataExtract(s *server.MCPServer, deps Deps) {
	const kind = "track.metadata.extract"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Parse the source filename via LLM, probe the canonical mp3 with ffprobe, resolve author/location/source against the catalog. Writes meta.json sidecar; does NOT commit to current.db (that's track_commit). Synchronous; for batch use pipeline.run only=metadata selector=…."),
		mcp.WithString("track_id", mcp.Required()),
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
		// Look up the source path so the extractor sees the real filename.
		path, err := lookupSourcePath(ctx, deps, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeNotFound, err.Error(), nil), nil
		}
		res, err := deps.Metadata.Run(ctx, id, path)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
	_ = extractmeta.UseCase{} // keep import explicit
}

// lookupSourcePath finds the original input-lake path for trackId by scanning.
// Slow on huge lakes, but called rarely (interactive).
func lookupSourcePath(ctx context.Context, deps Deps, id track.Id) (string, error) {
	cursor := ""
	for {
		page, next, err := deps.Registry.Scan(ctx, 200, cursor)
		if err != nil {
			return "", err
		}
		for _, fr := range page {
			if fr.Id == id {
				return fr.Source.Path, nil
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	return "", &SourceNotFound{Id: id}
}

type SourceNotFound struct{ Id track.Id }

func (e *SourceNotFound) Error() string { return "source path not found for track " + string(e.Id) }
