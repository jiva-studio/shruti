package tools

import (
	"context"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/runner"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// RegisterTranscriptAlignPDF wires the `transcript_align_pdf` tool — runs
// the PDF-canon-to-ASR-timing aligner directly, bypassing the LLM review
// path. Use this when the track has an authoritative transcript.pdf
// alongside its raw.json and you want to skip paying for review.
//
// transcript_review with prefer=auto will dispatch to the same code path
// automatically when a PDF is present. For BATCH alignment use
// pipeline.run op=align_pdf selector=…  (it auto-narrows has_pdf=true).
func RegisterTranscriptAlignPDF(s *server.MCPServer, deps Deps) {
	const kind = "track.transcript.align_pdf"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Build a reviewed transcript by aligning the canonical PDF transcript "+
				"(out/artifacts/tracks/{id}/transcript.pdf) to the raw ASR segments "+
				"(out/artifacts/tracks/{id}/transcripts/{lang}/raw.json). Produces "+
				"out/public/tracks/{id}/transcripts/{lang}.json with verse:text + "+
				"verse:translation + sentence blocks and references resolved to canonical "+
				"catalog source IDs. Marks the reviewed stage done. Faster and free vs "+
				"transcript_review's LLM path; requires the PDF to be present. Async: "+
				"returns a run_id; poll via runs.status / runs.wait. For batch use "+
				"pipeline.run op=align_pdf selector=…."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required(), mcp.Description("ISO-639 code (en/ru/hi).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
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
		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindTranscriptAlignPDF,
			Cancellable: true,
			Init: run.Run{
				Targets:  []string{string(id)},
				Progress: run.Progress{FilesTotal: 1},
			},
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				res, err := deps.AlignPDF.Run(workCtx, id, lang)
				if err != nil {
					return nil, err
				}
				report(run.Progress{FilesTotal: 1, FilesDone: 1})
				return json.Marshal(res)
			},
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
		}
		return envelope.Run(kind, runDispatch{
			Id:            runId,
			Kind:          string(run.KindTranscriptAlignPDF),
			State:         string(run.StateQueued),
			AcceptedCount: 1,
		}), nil
	})
}
