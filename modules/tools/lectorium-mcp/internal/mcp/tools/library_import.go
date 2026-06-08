package tools

import (
	"context"
	"encoding/json"
	"log"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	mediaapp "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/library/media"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/runner"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// LibraryImportDeps wires the library media import use case.
type LibraryImportDeps struct {
	UseCase mediaapp.UseCase
}

// RegisterLibraryImport wires library.import — async batch import of media
// items (e.g. short remembrance clips) into library_media. Each record mints
// an id, uploads its local file (+ optional sibling .jpg poster) to S3 under
// public/media/<id>.<ext>, and upserts one row. Idempotent and safe to re-run.
// Returns a run_id; monitor via runs.status / runs.wait.
func RegisterLibraryImport(s *server.MCPServer, deps Deps) {
	const kind = "library.import"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Start an asynchronous media import into library_media. Provide the plan "+
				"as `json` (inline) OR `json_path` (file on the server). Plan shape: "+
				"{\"records\":[{lang,title,text,context,embed_text,type,media_path,meta}]}. "+
				"Per record: mints an id, uploads media_path to public/media/<id><ext> "+
				"(and a sibling <media_path>.jpg poster to public/media/<id>.jpg if present), "+
				"then upserts one library_media row (INSERT OR REPLACE). Idempotent and "+
				"safe to re-run. Returns a run_id; monitor via runs.status / runs.wait. "+
				"Publish the corpus afterwards with library.publish."),
		mcp.WithString("json", mcp.Description("Inline JSON plan. Mutually exclusive with json_path.")),
		mcp.WithString("json_path", mcp.Description("Path to a JSON plan file on the server. Mutually exclusive with json.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
		inline := req.GetString("json", "")
		path := req.GetString("json_path", "")
		if (inline == "") == (path == "") {
			return envelope.Err(kind, envelope.CodeInvalidArgument,
				"provide exactly one of `json` or `json_path`", nil), nil
		}
		var data []byte
		if inline != "" {
			data = []byte(inline)
		} else {
			b, err := os.ReadFile(path)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInvalidArgument,
					"read json_path: "+err.Error(), nil), nil
			}
			data = b
		}
		plan, err := mediaapp.ParsePlan(data)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}

		uc := deps.LibraryImport.UseCase
		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindLibraryImport,
			Cancellable: true,
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				opts := mediaapp.Options{
					Plan: plan,
					OnProgress: func(p mediaapp.ProgressTick) {
						report(run.Progress{
							FilesTotal: p.FilesTotal,
							FilesDone:  p.FilesDone,
						})
						log.Printf("[library.import] %d/%d records imported", p.FilesDone, p.FilesTotal)
					},
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
			Kind:          string(run.KindLibraryImport),
			State:         "queued",
			AcceptedCount: len(plan.Records),
		}), nil
	})
}
