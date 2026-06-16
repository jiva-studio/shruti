package tools

import (
	"context"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/registeraudio"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/runner"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
	audioport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/audio"
)

func RegisterAudioNormalize(s *server.MCPServer, deps Deps) {
	const kind = "track.audio.normalize"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Re-encode the source mp3 to the canonical 128 kbps CBR LAME and write to public/. Channels preserved from source. No loudness/dynamic-range processing. Async: returns a run_id; poll via runs.status / runs.wait. For batch use pipeline.run only=normalized selector=…."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("Track id.")),
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
		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindAudioNormalize,
			Cancellable: true,
			Init: run.Run{
				Targets:  []string{string(id)},
				Progress: run.Progress{FilesTotal: 1},
			},
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				if err := deps.Normalize.Run(workCtx, id); err != nil {
					return nil, err
				}
				report(run.Progress{FilesTotal: 1, FilesDone: 1})
				return json.Marshal(struct {
					TrackId    string `json:"track_id"`
					AudioPath  string `json:"audio_path"`
					SourcePath string `json:"source_path"`
				}{
					TrackId:    string(id),
					AudioPath:  deps.Normalize.Audio.PublicAudioPath(id, audioport.VersionOriginal),
					SourcePath: deps.Normalize.Audio.SourceArtifactPath(id),
				})
			},
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
		}
		return envelope.Run(kind, runDispatch{
			Id:            runId,
			Kind:          string(run.KindAudioNormalize),
			State:         string(run.StateQueued),
			AcceptedCount: 1,
		}), nil
	})
}

func RegisterAudioRegister(s *server.MCPServer, deps Deps) {
	const kind = "track.audio.register"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Bulk-register track_audio rows for ALREADY-existing audio files on S3 — no processing, no denoise. Records out-of-band versions (e.g. clean.mp3 produced by the batch denoiser) into the catalog in ONE transaction. `items` is a JSON array of {track_id, language, kind, size_bytes?, duration_ms?}; size/duration default to the variant's 'original' row when omitted. Sync. Run catalog.publish afterwards to make it live."),
		mcp.WithString("items", mcp.Required(), mcp.Description("JSON array: [{\"track_id\":\"track_..\",\"language\":\"en\",\"kind\":\"clean\",\"size_bytes\":123,\"duration_ms\":456}, ...]")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, err := req.RequireString("items")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		var items []registeraudio.Item
		if err := json.Unmarshal([]byte(raw), &items); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "items: "+err.Error(), nil), nil
		}
		if len(items) == 0 {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "items is empty", nil), nil
		}
		res, err := deps.RegisterAudio.RunBulk(ctx, items)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func RegisterAudioDenoise(s *server.MCPServer, deps Deps) {
	const kind = "track.audio.denoise"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Denoise the committed original.mp3 into clean.mp3 (run audio-denoiser locally) and register a track_audio kind=clean row so the app can offer the original↔clean source-mix. clean.mp3 ships to S3 via the normal asset push. Async: returns a run_id; poll via runs.status / runs.wait."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("Track id.")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Variant language (the clean row is written for this locale).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
		tid, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		language, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		id, err := track.NewId(tid)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindAudioDenoise,
			Cancellable: true,
			Init: run.Run{
				Targets:  []string{string(id)},
				Progress: run.Progress{FilesTotal: 1},
			},
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				res, err := deps.AudioDenoise.Run(workCtx, id, language)
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
			Kind:          string(run.KindAudioDenoise),
			State:         string(run.StateQueued),
			AcceptedCount: 1,
		}), nil
	})
}
