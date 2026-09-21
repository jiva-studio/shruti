package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	librarypublish "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/library/publish"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/runner"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// LibraryPublishDeps wires the library publish use case.
type LibraryPublishDeps struct {
	UseCase librarypublish.UseCase
}

// RegisterLibraryPublish wires library.publish — async upload of
// library.db to S3 with a versioned key, then merges a new entry into
// public/config.json under the `library` field. Independent of
// catalog.publish so the two artifacts can ship on their own cadence.
func RegisterLibraryPublish(s *server.MCPServer, deps Deps) {
	const kind = "library.publish"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Start an asynchronous library publish: bumps version, uploads "+
				"artifacts/library/library.db to S3 as public/library/library.{ver}.db, "+
				"then merges a new entry into public/config.json under the `library` "+
				"field (independent of the catalog's version ladder). Returns a run_id; "+
				"monitor via runs.status / runs.wait."),
		mcp.WithBoolean("dry_run", mcp.Description("If true, compute the publish plan without uploading.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
		opts := librarypublish.Options{
			DryRun: req.GetBool("dry_run", false),
		}
		uc := deps.LibraryPublish.UseCase

		runID, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindPublish,
			Cancellable: true,
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				opts.OnProgress = func(p librarypublish.ProgressTick) {
					report(run.Progress{
						FilesTotal: p.FilesTotal,
						FilesDone:  p.FilesDone,
					})
					log.Printf("[library.publish] %d/%d steps, %.1f MB sent",
						p.FilesDone, p.FilesTotal, float64(p.BytesUploaded)/1e6)
				}
				res, err := uc.Run(workCtx, opts)
				if err != nil {
					return nil, err
				}
				body, _ := json.Marshal(res)
				return body, nil
			},
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, fmt.Sprintf("submit run: %v", err), nil), nil
		}
		return envelope.Run(kind, runDispatch{
			ID:            runID,
			Kind:          string(run.KindPublish),
			State:         "queued",
			AcceptedCount: 1,
		}), nil
	})
}
