package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// RegisterTrackIngest is the synchronous, single-file ingest tool: hash,
// mint trackID, move source.mp3 into artifacts/. Returns immediately.
//
// Bulk ingest is no longer this tool's job — `pipeline_run selector={
// source: lake } up_to=ingested` covers it through the unified selector
// + worker-pool path.
func RegisterTrackIngest(s *server.MCPServer, deps Deps) {
	const kind = "track.ingest"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Ingest one mp3 file synchronously: hash, mint trackId, move "+
				"source.mp3 into out/artifacts/tracks/{id}/. Returns the "+
				"trackId. For bulk ingest of fresh lake mp3s, use "+
				"`pipeline_run selector={source:\"lake\"} up_to=ingested`."),
		mcp.WithString("path", mcp.Required(), mcp.Description("Absolute or --in-relative path to mp3.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(deps.InDir, path)
		}
		res, err := deps.Ingest.Run(ctx, path)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, struct {
			TrackID       string `json:"track_id"`
			SHA256Changed bool   `json:"sha256_changed"`
		}{string(res.TrackID), res.SHA256Changed}), nil
	})
}

func RegisterTrackStatus(s *server.MCPServer, deps Deps) {
	const kind = "track.status"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Show pipeline state for one track (by trackId or input path). Default response omits per-stage payload (which can be large — full metadata, audio probe, transcript counts, review session). Pass verbose=true to include payload. The payloads are also persisted on disk under out/artifacts/tracks/{id}/."),
		mcp.WithString("track_id", mcp.Description("Track id (track_<12 alnum>).")),
		mcp.WithString("path", mcp.Description("Source path (alternative to track_id).")),
		mcp.WithBoolean("verbose", mcp.Description("Include per-stage payload in response. Default false.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		tid := req.GetString("track_id", "")
		path := req.GetString("path", "")
		verbose := req.GetBool("verbose", false)
		var id track.ID
		var err error
		switch {
		case tid != "":
			id, err = track.NewID(tid)
		case path != "":
			if !filepath.IsAbs(path) {
				path = filepath.Join(deps.InDir, path)
			}
			abs, errAbs := filepath.Abs(path)
			if errAbs != nil {
				return envelope.Err(kind, envelope.CodeInvalidArgument, errAbs.Error(), nil), nil
			}
			if rp, errSL := filepath.EvalSymlinks(abs); errSL == nil {
				abs = rp
			}
			var ok bool
			id, ok, err = deps.Registry.LookupByPath(ctx, abs)
			if err == nil && !ok {
				return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("no track for path %s", abs), nil), nil
			}
		default:
			return envelope.Err(kind, envelope.CodeInvalidArgument, "track_id or path required", nil), nil
		}
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		stages, err := deps.Registry.ListAllStages(ctx, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		type stageOut struct {
			Stage      string          `json:"stage"`
			Variant    string          `json:"variant,omitempty"`
			Status     string          `json:"status"`
			StartedAt  string          `json:"started_at,omitempty"`
			FinishedAt string          `json:"finished_at,omitempty"`
			Error      string          `json:"error,omitempty"`
			Payload    json.RawMessage `json:"payload,omitempty"`
		}
		out := struct {
			TrackID string     `json:"track_id"`
			Stages  []stageOut `json:"stages"`
		}{TrackID: string(id)}
		for _, sr := range stages {
			s := stageOut{
				Stage:      string(sr.Key.Stage),
				Variant:    sr.Key.Variant,
				Status:     string(sr.Status),
				StartedAt:  sr.StartedAt,
				FinishedAt: sr.FinishedAt,
				Error:      sr.Error,
			}
			if verbose && len(sr.Payload) > 0 {
				s.Payload = sr.Payload
			}
			out.Stages = append(out.Stages, s)
		}
		return envelope.Result(kind, out), nil
	})
}
