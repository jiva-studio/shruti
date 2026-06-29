package tools

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/configpublish"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// ConfigPublishDeps bundles the config-only publish use case. Shares
// catalog.publish's S3 targets + mutex (wired in main.go).
type ConfigPublishDeps struct {
	UseCase configpublish.UseCase
}

func RegisterConfigPublish(s *server.MCPServer, deps ConfigPublishDeps) {
	const kind = "catalog.config.publish"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Publish ONLY the config sections (regions + proactive) from the local config.json to S3 public/config.json on every target. No database upload, no version bump — use this to roll out a server/IP or proactive change without touching the catalog DB. The databases/library keys on S3 are preserved. For a full publish (DB + config) use catalog.publish."),
		mcp.WithBoolean("dry_run", mcp.Description("If true, report which sections/targets would be written without uploading.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		res, err := deps.UseCase.Run(ctx, configpublish.Options{DryRun: req.GetBool("dry_run", false)})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}
