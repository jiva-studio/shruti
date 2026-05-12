package tools

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/auditreview"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// audit_summary is the synchronous companion to pipeline.run op=audit. It
// runs the corpus aggregator inline with a top-N cap so the response fits
// in Claude's context budget. For an unbounded full-corpus walk, prefer
// pipeline.run op=audit which writes the full result into the run record.
//
// Replaces the old async-only audit_review tool — same aggregator output,
// caller doesn't need to dispatch a run + wait + read for the common
// "quick health check" call.
func RegisterAuditSummary(s *server.MCPServer, deps Deps) {
	const kind = "audit.summary"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Synchronous corpus audit — walks tracks matched by `selector` "+
				"that have reviewed:done and reports fallback/flag stats. "+
				"Empty selector = whole corpus. Top-N offenders capped at "+
				"100 inline (default 20) so the response fits in context. "+
				"For an uncapped walk over thousands of tracks, use "+
				"pipeline.run op=audit selector=…  — the full result lives "+
				"in run.Result and is retrievable via runs.status."),
		mcp.WithObject("selector", mcp.Description(
			"track.Selector — see tracks_select. Common: "+
				"{languages: [ru]} or "+
				"{enrich_audit: true, audit_fallback: {min_chunks: 3}} to "+
				"pre-narrow before the audit walks artifacts.")),
		mcp.WithNumber("top", mcp.Description("Cap the top_offenders list at N (default 20, max 100).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		dom, err := parseSelector(req)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		sel := dom.Selector

		var candidates []auditreview.Candidate
		if !selectorIsEmpty(sel) {
			rows, err := deps.SelectTracks.Run(ctx, sel)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, "resolve selector: "+err.Error(), nil), nil
			}
			for _, r := range rows {
				if r.TrackId == "" || r.Language == "" {
					continue
				}
				candidates = append(candidates, auditreview.Candidate{
					TrackId:  r.TrackId,
					Language: r.Language,
				})
			}
		}

		top := int(req.GetFloat("top", 20))
		if top > 100 {
			top = 100
		}

		uc := auditreview.UseCase{
			Registry:    deps.Registry,
			Transcripts: deps.Transcripts,
		}
		res, err := uc.Run(ctx, auditreview.Options{
			Candidates: candidates,
			Top:        top,
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

// selectorIsEmpty checks whether the selector has any meaningful narrowing
// fields set. We compare against a zeroed Selector with Source defaulted.
func selectorIsEmpty(s track.Selector) bool {
	if s.Source != "" && s.Source != track.SourceBoth {
		return false
	}
	return len(s.Languages) == 0 &&
		s.PathGlob == "" && s.PathPrefix == "" &&
		s.HasPDF == nil && len(s.KindTags) == 0 &&
		s.LastDoneStage == "" && len(s.StageStatus) == 0 &&
		!s.EnrichAudit && s.AuditFallback == nil && s.LowConfMinSegs == 0 &&
		s.SizeMin == 0 && s.SizeMax == 0 &&
		s.DiscoveredAfter.IsZero() && s.DiscoveredBefore.IsZero()
}

// audit_track is the per-track companion to audit_summary. Walks every
// chunk_NNNN.json for one (track, language), lists the chunks that need
// attention (failed, flagged, or carrying low-confidence segments).
func RegisterAuditTrack(s *server.MCPServer, deps Deps) {
	const kind = "audit.track"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Per-track audit: walks chunk_NNNN.json artifacts and lists fallback/flagged/low-confidence chunks plus a suggested premium re-run command. Use after audit_summary picks out a problematic track."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required(), mcp.Description("ISO-639 code (ru/en/hi).")),
		mcp.WithNumber("low_conf_threshold", mcp.Description("Confidence cut-off for surfacing segments (default 0.70).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
		uc := auditreview.UseCase{
			Registry:    deps.Registry,
			Transcripts: deps.Transcripts,
		}
		res, err := uc.RunTrack(ctx, auditreview.TrackOptions{
			TrackId:      id,
			Language:     lang,
			LowConfLimit: req.GetFloat("low_conf_threshold", 0),
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}
