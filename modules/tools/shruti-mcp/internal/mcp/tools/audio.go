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
					AudioPath:  deps.Normalize.Audio.PublicAudioPath(id),
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
