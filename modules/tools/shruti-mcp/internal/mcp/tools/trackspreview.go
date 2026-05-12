package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// RegisterTracksSelect wires the tracks_select MCP tool — the diagnostic
// front-end of the unified track.Selector. Resolves the selector, returns
// the matched rows. Same selector schema is consumed by pipeline_run,
// audit_review, and the bulk per-track tools, so this is the canonical
// way to preview "what would the next batch operation actually run on".
func RegisterTracksSelect(s *server.MCPServer, deps Deps) {
	const kind = "tracks.preview"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Resolve a track selector to a list of candidate mp3 files. "+
				"Returns one row per match with path, track_id, language, "+
				"has_pdf, last_done stage, kind_tag, size, ingested_at, and "+
				"audit metrics (when enrich_audit=true). Use to preview what "+
				"a bulk operation (pipeline_run / tracks_*_bulk / audit_review) "+
				"will operate on, and to enumerate fresh mp3s in the lake "+
				"that aren't ingested yet (selector.source=lake)."),
		mcp.WithObject("selector", mcp.Description(
			"track.Selector value: {source: registry|lake|both, languages: [..], "+
				"track_ids: [..], path_glob, path_prefix, has_pdf: bool, kind_tags: [..], "+
				"last_done_stage, stage_status: {<stage>: <status>}, "+
				"enrich_audit: bool, audit_fallback: {min_chunks}, "+
				"low_conf_min_segs, size_min, size_max, "+
				"discovered_after, discovered_before (RFC3339), limit}.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var raw selectorJSON
		if obj := req.GetArguments(); obj != nil {
			if v, ok := obj["selector"]; ok && v != nil {
				body, err := json.Marshal(v)
				if err != nil {
					return envelope.Err(kind, envelope.CodeInvalidArgument, fmt.Sprintf("selector: %v", err), nil), nil
				}
				if err := json.Unmarshal(body, &raw); err != nil {
					return envelope.Err(kind, envelope.CodeInvalidArgument, fmt.Sprintf("selector: %v", err), nil), nil
				}
			}
		}
		sel, err := raw.toDomain()
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}

		rows, err := deps.SelectTracks.Run(ctx, sel)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}

		type rowOut struct {
			Path         string `json:"path"`
			TrackId      string `json:"track_id,omitempty"`
			Language     string `json:"language,omitempty"`
			HasPDF       bool   `json:"has_pdf"`
			LastDone     string `json:"last_done,omitempty"`
			KindTag      string `json:"kind_tag,omitempty"`
			Size         int64  `json:"size,omitempty"`
			DiscoveredAt string `json:"discovered_at,omitempty"`
			Audit        *struct {
				FallbackChunks    int `json:"fallback_chunks"`
				LowConfidenceSegs int `json:"low_confidence_segs"`
				NoiseFilteredSegs int `json:"noise_filtered_segs"`
				TotalChunks       int `json:"total_chunks"`
			} `json:"audit,omitempty"`
		}
		out := make([]rowOut, 0, len(rows))
		for _, r := range rows {
			row := rowOut{
				Path:         r.Path,
				TrackId:      string(r.TrackId),
				Language:     r.Language,
				HasPDF:       r.HasPDF,
				LastDone:     string(r.LastDone),
				KindTag:      r.KindTag,
				Size:         r.Size,
				DiscoveredAt: optionalTime(r.DiscoveredAt),
			}
			if sel.EnrichAudit {
				row.Audit = &struct {
					FallbackChunks    int `json:"fallback_chunks"`
					LowConfidenceSegs int `json:"low_confidence_segs"`
					NoiseFilteredSegs int `json:"noise_filtered_segs"`
					TotalChunks       int `json:"total_chunks"`
				}{
					FallbackChunks:    r.AuditCount.FallbackChunks,
					LowConfidenceSegs: r.AuditCount.LowConfidenceSegs,
					NoiseFilteredSegs: r.AuditCount.NoiseFilteredSegs,
					TotalChunks:       r.AuditCount.TotalChunks,
				}
			}
			out = append(out, row)
		}
		return envelope.Result(kind, struct {
			Files []rowOut `json:"files"`
			Count int      `json:"count"`
		}{out, len(out)}), nil
	})
}

// selectorJSON is the over-the-wire shape of track.Selector. Stays JSON-y
// (string enums, nested object) so the MCP tool spec is readable.
type selectorJSON struct {
	Source           string                       `json:"source,omitempty"`
	Languages        []string                     `json:"languages,omitempty"`
	TrackIds         []string                     `json:"track_ids,omitempty"`
	PathGlob         string                       `json:"path_glob,omitempty"`
	PathPrefix       string                       `json:"path_prefix,omitempty"`
	HasPDF           *bool                        `json:"has_pdf,omitempty"`
	KindTags         []string                     `json:"kind_tags,omitempty"`
	LastDoneStage    string                       `json:"last_done_stage,omitempty"`
	StageStatus      map[string]string            `json:"stage_status,omitempty"`
	EnrichAudit      bool                         `json:"enrich_audit,omitempty"`
	AuditFallback    *struct{ MinChunks int       `json:"min_chunks"` } `json:"audit_fallback,omitempty"`
	LowConfMinSegs   int                          `json:"low_conf_min_segs,omitempty"`
	SizeMin          int64                        `json:"size_min,omitempty"`
	SizeMax          int64                        `json:"size_max,omitempty"`
	DiscoveredAfter  string                       `json:"discovered_after,omitempty"`
	DiscoveredBefore string                       `json:"discovered_before,omitempty"`
	Limit            int                          `json:"limit,omitempty"`
}

func (r selectorJSON) toDomain() (track.Selector, error) {
	sel := track.Selector{
		Source:         track.SelectorSource(r.Source),
		Languages:      r.Languages,
		TrackIds:       r.TrackIds,
		PathGlob:       r.PathGlob,
		PathPrefix:     r.PathPrefix,
		HasPDF:         r.HasPDF,
		KindTags:       r.KindTags,
		LastDoneStage:  pipeline.Stage(r.LastDoneStage),
		EnrichAudit:    r.EnrichAudit,
		LowConfMinSegs: r.LowConfMinSegs,
		SizeMin:        r.SizeMin,
		SizeMax:        r.SizeMax,
		Limit:          r.Limit,
	}
	if r.AuditFallback != nil {
		sel.AuditFallback = &track.FallbackSpec{MinChunks: r.AuditFallback.MinChunks}
	}
	if len(r.StageStatus) > 0 {
		sel.StageStatus = make(map[pipeline.Stage]pipeline.Status, len(r.StageStatus))
		for k, v := range r.StageStatus {
			sel.StageStatus[pipeline.Stage(k)] = pipeline.Status(v)
		}
	}
	if r.DiscoveredAfter != "" {
		t, err := time.Parse(time.RFC3339, r.DiscoveredAfter)
		if err != nil {
			return track.Selector{}, fmt.Errorf("discovered_after: %w", err)
		}
		sel.DiscoveredAfter = t
	}
	if r.DiscoveredBefore != "" {
		t, err := time.Parse(time.RFC3339, r.DiscoveredBefore)
		if err != nil {
			return track.Selector{}, fmt.Errorf("discovered_before: %w", err)
		}
		sel.DiscoveredBefore = t
	}
	return sel, nil
}

func optionalTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
