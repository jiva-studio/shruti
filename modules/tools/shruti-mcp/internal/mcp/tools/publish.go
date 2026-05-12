package tools

import (
	"context"
	"encoding/json"
	"log"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/catalog/publish"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/runner"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// RegisterCatalogPublish wires catalog_publish — starts an async publish
// run via the unified runner. Returns a run_id; callers monitor through
// run_status / run_wait. The previous bespoke PublishManager (with its
// own mutex + atomic counters and the catalog_publish_status companion
// tool) is gone — publish is just another kind of run now.
//
// publish.UseCase keeps its own OpMutex internally so two concurrent
// catalog_publish runs serialize at the use-case boundary; the runner
// doesn't need to enforce that on top.
func RegisterCatalogPublish(s *server.MCPServer, deps Deps) {
	const kind = "catalog.publish"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Start an asynchronous publish of out/ to S3 (bumps version, "+
				"copies current.db → public/db/shruti.{ver}.db, uploads every "+
				"file under public/ and artifacts/, merges public/config.json). "+
				"Incremental by default: skips files whose S3 size matches local. "+
				"Returns a run_id; monitor via run_status / run_wait."),
		mcp.WithBoolean("dry_run", mcp.Description("If true, the background run computes the upload plan without uploading.")),
		mcp.WithBoolean("force_full", mcp.Description("Re-upload every file even if size matches on S3. Use after a content migration where the byte count happens to be unchanged.")),
		mcp.WithBoolean("verify_checksum", mcp.Description("Skip only when the remote ETag matches the local MD5; multipart-uploaded objects always re-upload under this flag. Off by default — turn on after content drift where size alone isn't trustworthy.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
		opts := publish.Options{
			DryRun:         req.GetBool("dry_run", false),
			ForceFull:      req.GetBool("force_full", false),
			VerifyChecksum: req.GetBool("verify_checksum", false),
		}
		uc := deps.Publish

		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindPublish,
			Cancellable: true,
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				// Hook progress callback so run_status sees live counters
				// AND the daemon log gets a heartbeat every ~10 files
				// (cheap way to spot a stalled S3 upload from the log).
				opts.OnProgress = func(p publish.ProgressTick) {
					report(run.Progress{
						FilesTotal: p.FilesTotal,
						FilesDone:  p.FilesDone,
						StageBreakdown: map[string]int{
							"uploaded": p.FilesUploaded,
							"skipped":  p.FilesSkipped,
						},
					})
					if p.FilesDone == p.FilesTotal || p.FilesDone%10 == 0 {
						log.Printf("[publish] %d/%d files (uploaded %d, skipped %d), %.1f MB sent",
							p.FilesDone, p.FilesTotal, p.FilesUploaded, p.FilesSkipped,
							float64(p.BytesUploaded)/1e6)
					}
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
			return envelope.Err(kind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
		}
		return envelope.Run(kind, runDispatch{
			Id:            runId,
			Kind:          string(run.KindPublish),
			State:         "queued",
			AcceptedCount: 1,
		}), nil
	})
}
