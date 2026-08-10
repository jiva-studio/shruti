package tools

import (
	"context"
	"encoding/json"
	"log"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/publish"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/runner"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// RegisterCatalogPublish wires catalog.publish — starts an async publish
// run via the unified runner. Returns a run_id; callers monitor through
// run_status / run_wait.
//
// Publish is now minimal: upload the freshly-built catalog DB to S3 under
// public/db/lectorium.{ver}.db and flip public/config.json to advertise
// it. Asset files under out/public/ and out/artifacts/ are NOT swept up
// here — those live in S3 independently of the publish step.
//
// publish.UseCase keeps its own OpMutex internally so two concurrent
// catalog.publish runs serialize at the use-case boundary; the runner
// doesn't need to enforce that on top.
func RegisterCatalogPublish(s *server.MCPServer, deps Deps) {
	const kind = "catalog.publish"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Start an asynchronous catalog publish: bumps version, uploads "+
				"artifacts/catalog/current.db to S3 as public/db/lectorium.{ver}.db, "+
				"then flips public/config.json to point at it. Asset files (audio, "+
				"images) are NOT uploaded — they are pushed by their own pipelines. "+
				"Returns a run_id; monitor via runs.status / runs.wait."),
		mcp.WithBoolean("dry_run", mcp.Description("If true, compute the publish plan (db key + config flip) and report the asset check without uploading.")),
		mcp.WithBoolean("skip_asset_check", mcp.Description("Skip probing the target for the transcripts the catalog advertises. Escape hatch only: the published catalog may then point the chat indexer at files that are not there.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
		opts := publish.Options{
			DryRun:         req.GetBool("dry_run", false),
			SkipAssetCheck: req.GetBool("skip_asset_check", false),
		}
		uc := deps.Publish

		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindPublish,
			Cancellable: true,
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				opts.OnProgress = func(p publish.ProgressTick) {
					report(run.Progress{
						FilesTotal: p.FilesTotal,
						FilesDone:  p.FilesDone,
					})
					log.Printf("[publish] %d/%d steps, %.1f MB sent",
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
