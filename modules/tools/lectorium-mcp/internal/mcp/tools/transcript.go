package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	reviewuc "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/review"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/runner"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/transcribe"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

func RegisterTranscriptCreate(s *server.MCPServer, deps Deps) {
	const kind = "track.transcript.create"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Run a transcription provider on the canonical mp3 to produce a raw segments JSON. Output: out/artifacts/tracks/{id}/transcripts/{lang}/raw.json. Async: returns a run_id; poll via runs.status / runs.wait. For batch use pipeline.run only=transcribed selector=…."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required(), mcp.Description("ISO-639 code (ru/en/hi).")),
		mcp.WithString("provider", mcp.Description("Transcriber name (default = configured default).")),
		mcp.WithString("model", mcp.Description("Override default model path/identifier (optional).")),
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
		opts := transcribe.Options{
			Provider: req.GetString("provider", ""),
			Model:    req.GetString("model", ""),
		}
		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindTranscriptCreate,
			Cancellable: true,
			Init: run.Run{
				Targets:  []string{string(id)},
				Progress: run.Progress{FilesTotal: 1},
			},
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				res, err := deps.Transcribe.Run(workCtx, id, lang, opts)
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
			Kind:          string(run.KindTranscriptCreate),
			State:         string(run.StateQueued),
			AcceptedCount: 1,
		}), nil
	})
}

func RegisterTranscriptReview(s *server.MCPServer, deps Deps) {
	const kind = "track.transcript.review"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Proofread the raw transcript via an LLM provider with frozen "+
				"timestamps. Outputs out/public/tracks/{id}/transcripts/{lang}.json + "+
				"out/artifacts/tracks/{id}/transcripts/{lang}/review.json. "+
				"Async: returns a run_id; poll via runs.status / runs.wait. "+
				"Resumable: chunk_NNNN.json artifacts marked ok=true survive "+
				"runs.cancel and are picked up by the next run on the same track. "+
				"force_full_rerun=true starts clean. only_chunks=\"3,4,5\" retries just "+
				"those indices. For BATCH review of many tracks, use pipeline.run "+
				"only=reviewed selector=…."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("models", mcp.Description("Comma-separated list of model aliases from config (review.providers.*). 1 = single pass (e.g. \"gemini-3-flash-preview\"). 2 = hybrid: first baseline on every chunk, second premium on low-confidence islands (e.g. \"gemini-3.1-flash-lite,gemini-3.1-pro-preview\"). Empty = use review.default[language] from config.")),
		mcp.WithNumber("chunk_size", mcp.Description("Segments per LLM call. Default 50.")),
		mcp.WithNumber("overlap", mcp.Description("Overlap between chunks. Default 4.")),
		mcp.WithBoolean("force_full_rerun", mcp.Description("Re-run every chunk through the LLM, ignoring existing successful artifacts. Default false (resume from disk).")),
		mcp.WithString("only_chunks", mcp.Description("Comma-separated 0-based chunk indices to process (e.g. \"3,4,5\"). Other chunks fall through unchanged unless they already have a successful artifact.")),
		mcp.WithString("method", mcp.Description("How to produce the reviewed transcript: \"auto\" (default — PDF align if transcript.pdf is present, else LLM), \"pdf\" (force PDF align; error if no PDF), \"llm\" (force LLM, ignore any PDF). PDF align uses transcript_align_pdf internally and is much faster + free.")),
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
		opts := reviewuc.Options{
			Models:         parseModelsCSV(req.GetString("models", "")),
			ChunkSize:      int(req.GetFloat("chunk_size", 0)),
			Overlap:        int(req.GetFloat("overlap", 0)),
			ForceFullRerun: req.GetBool("force_full_rerun", false),
			Method:         req.GetString("method", ""),
		}
		if raw := strings.TrimSpace(req.GetString("only_chunks", "")); raw != "" {
			for _, part := range strings.Split(raw, ",") {
				part = strings.TrimSpace(part)
				if part == "" {
					continue
				}
				n, perr := strconv.Atoi(part)
				if perr != nil {
					return envelope.Err(kind, envelope.CodeInvalidArgument, fmt.Sprintf("only_chunks: %q is not an integer", part), nil), nil
				}
				opts.OnlyChunks = append(opts.OnlyChunks, n)
			}
		}

		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindTranscriptReview,
			Cancellable: true,
			Init: run.Run{
				Targets:  []string{string(id)},
				Progress: run.Progress{FilesTotal: 1},
			},
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				res, err := deps.Review.Run(workCtx, id, lang, opts)
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
			Kind:          string(run.KindTranscriptReview),
			State:         string(run.StateQueued),
			AcceptedCount: 1,
		}), nil
	})
}

// parseModelsCSV splits a comma-separated list of model aliases, trimming
// whitespace and dropping empties. Empty input yields nil.
func parseModelsCSV(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func RegisterProviderList(s *server.MCPServer, deps Deps) {
	const kind = "provider.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List registered providers (transcribers, review reviewers, catalog resolver)."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return envelope.Result(kind, struct {
			Transcribe []string `json:"transcribe"`
			Review     []string `json:"review"`
			Resolver   string   `json:"resolver"`
		}{
			Transcribe: deps.Transcribe.Transcribers.List(),
			Review:     deps.Review.Reviewers.List(),
			Resolver:   deps.Find.Resolver.Name(),
		}), nil
	})
}
