package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/assetsync"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/assets/decider"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// AssetSyncDeps wires the use case for the assets.sync tool.
type AssetSyncDeps struct {
	UseCase assetsync.UseCase
}

func RegisterAssetSync(s *server.MCPServer, deps AssetSyncDeps) {
	const kind = "assets.sync"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Upload out/public/ (track audio, transcripts, covers) to the publish "+
				"targets. catalog.publish ships only the catalog DB and config.json; "+
				"this ships the files those point at. Resumable: what to send is "+
				"decided per file against the target, so re-running after an "+
				"interruption picks up the remainder."),
		mcp.WithString("strategy", mcp.Description(
			"size (default) uploads what is absent or the wrong length; "+
				"missing uploads only what is absent; force uploads everything.")),
		mcp.WithString("prefix", mcp.Description("Limit to a subtree of out/, e.g. public/tracks.")),
		mcp.WithArray("track_ids", mcp.Description("Limit to these tracks' assets.")),
		mcp.WithNumber("concurrency", mcp.Description("Files in flight per target (default 4).")),
		mcp.WithNumber("limit", mcp.Description("Stop after uploading this many files. 0 = no cap.")),
		mcp.WithBoolean("dry_run", mcp.Description("Report the plan, upload nothing.")),
		mcp.WithBoolean("uncommitted", mcp.Description(
			"Upload assets of tracks that have not been committed. Refused by "+
				"default: commit rewrites the public mp3 with ID3 tags, so an "+
				"earlier upload sends bytes that are about to change.")),
		mcp.WithBoolean("all", mcp.Description(
			"Also consider tracks already marked published. Off by default — the "+
				"registry remembers what reached the target, so a routine run does "+
				"not re-probe thousands of unchanged files.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		name := req.GetString("strategy", "")
		dec, ok := decider.ByName(name)
		if !ok {
			return envelope.Err(kind, envelope.CodeInvalidArgument,
				fmt.Sprintf("unknown strategy %q (size | missing | force)", name), nil), nil
		}
		opts := assetsync.Options{
			Prefix:      req.GetString("prefix", ""),
			Decider:     dec,
			Concurrency: int(req.GetFloat("concurrency", 0)),
			Limit:       int(req.GetFloat("limit", 0)),
			DryRun:      req.GetBool("dry_run", false),
			All:         req.GetBool("all", false),
			Uncommitted: req.GetBool("uncommitted", false),
		}
		if raw, ok := req.GetArguments()["track_ids"].([]any); ok {
			for _, v := range raw {
				if s, _ := v.(string); s != "" {
					opts.TrackIds = append(opts.TrackIds, s)
				}
			}
		}
		res, err := deps.UseCase.Run(ctx, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}
