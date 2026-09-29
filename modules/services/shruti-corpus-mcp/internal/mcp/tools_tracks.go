package mcpsrv

import (
	"context"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
)

// ── track_get / track_list / transcript_window ──────────────────────────────

func registerTrackGet(srv *server.MCPServer, d *Deps) {
	const kind = "track_get"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Get a track (lecture/conversation): metadata, cited references, transcript/pdf availability."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("track_id.")),
		mcp.WithString("lang", mcp.Description("Metadata language.")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		trackID := strings.TrimSpace(req.GetString("track_id", ""))
		if trackID == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "track_id is required", nil), nil
		}
		lang := req.GetString("lang", "")
		sd, ad, ld, err := d.loadDicts(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		tr, err := d.Catalog.GetTrack(ctx, trackID)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if tr == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such track", map[string]any{"track_id": trackID}), nil
		}
		obj := trackMeta(tr, ad, ld, lang)
		references := make([]map[string]any, 0, len(tr.Refs))
		for _, r := range tr.Refs {
			human := sd.RefString(r.SourceID, r.Tokens, lang)
			references = append(references, referenceObj(sd, r.SourceID, r.Tokens, human, lang))
		}
		obj["references"] = references
		obj["has_transcript"] = tr.HasTranscript()
		obj["has_pdf"] = tr.HasOutline
		logQuery(ctx, kind, "", nil, nil, 1, lang, start)
		return envelope.Result(kind, obj), nil
	})
}

func registerTrackList(srv *server.MCPServer, d *Deps) {
	const kind = "track_list"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("List tracks, filterable by reference (source[+tokens] = tracks citing it), "+
			"author/location/kind/date/lang. No filter ⇒ recent tracks (date desc)."),
		mcp.WithString("source", mcp.Description("Book code / source_id — tracks citing this book.")),
		mcp.WithString("tokens", mcp.Description("With source, filter to tracks citing this reference. A bare chapter number covers the WHOLE chapter (\"7\" = any BG 7.x lecture); add the verse for one verse (\"7.1\").")),
		mcp.WithString("author_id", mcp.Description("Speaker.")),
		mcp.WithString("location_id", mcp.Description("Location.")),
		mcp.WithString("kind", mcp.Description("lecture|conversation.")),
		mcp.WithString("date_from", mcp.Description("YYYY-MM-DD.")),
		mcp.WithString("date_to", mcp.Description("YYYY-MM-DD.")),
		mcp.WithString("lang", mcp.Description("Has a transcript in this language.")),
		mcp.WithString("cursor", mcp.Description("Pagination cursor.")),
		mcp.WithNumber("limit", mcp.Description("Max items (default 50, max 200).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang := req.GetString("lang", "")
		limit := clamp(req.GetInt("limit", 50), 50, 200)
		trackKind := req.GetString("kind", "")
		if trackKind != "" && !isTrackKind(trackKind) {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "kind must be lecture|conversation", nil), nil
		}
		sd, ad, ld, err := d.loadDicts(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		var sourceID string
		source := req.GetString("source", "")
		if source != "" {
			id, ok := resolveSourceParam(sd, source)
			if !ok {
				return envelope.Err(kind, envelope.CodeInvalidArgument, "unknown source: "+source, map[string]any{"source": source}), nil
			}
			sourceID = id
		}
		tokens := ""
		if tk := req.GetString("tokens", ""); tk != "" && sourceID != "" {
			tokens = refs.NormalizeToken(tk)
		}
		curDate, curID := decodeTrackCursor(req.GetString("cursor", ""))
		f := catalog.ListFilter{
			SourceID:   sourceID,
			Tokens:     tokens,
			AuthorID:   req.GetString("author_id", ""),
			LocationID: req.GetString("location_id", ""),
			Kind:       trackKind,
			DateFrom:   req.GetString("date_from", ""),
			DateTo:     req.GetString("date_to", ""),
			Lang:       lang,
			Limit:      limit + 1,
			CursorDate: curDate,
			CursorID:   curID,
		}
		tracks, err := d.Catalog.ListTracks(ctx, f)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		var next any
		if len(tracks) > limit {
			last := tracks[limit-1]
			next = encodeTrackCursor(last.Date, last.ID)
			tracks = tracks[:limit]
		}
		items := make([]map[string]any, 0, len(tracks))
		for _, tr := range tracks {
			items = append(items, trackMeta(tr, ad, ld, lang))
		}
		filters := map[string]any{}
		putIf(filters, "source", source)
		putIf(filters, "kind", trackKind)
		logQuery(ctx, kind, "", filters, nil, len(items), lang, start)
		return envelope.Result(kind, map[string]any{"items": items, "next_cursor": next}), nil
	})
}

func registerTranscriptWindow(srv *server.MCPServer, d *Deps) {
	const kind = "transcript_window"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Read a track's transcript around a time window (from a search track hit or track_list). "+
			"Widen with pad_ms."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("track_id.")),
		mcp.WithNumber("start_ms", mcp.Required(), mcp.Description("Window start (ms).")),
		mcp.WithNumber("end_ms", mcp.Required(), mcp.Description("Window end (ms), >= start_ms.")),
		mcp.WithNumber("pad_ms", mcp.Description("Extra ms each side (default 0).")),
		mcp.WithString("lang", mcp.Description("Transcript language.")),
		mcp.WithNumber("limit", mcp.Description("Max chunks (default 10, max 50).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		trackID := strings.TrimSpace(req.GetString("track_id", ""))
		if trackID == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "track_id is required", nil), nil
		}
		startMs := req.GetInt("start_ms", -1)
		endMs := req.GetInt("end_ms", -1)
		if startMs < 0 || endMs < 0 || endMs < startMs {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "start_ms/end_ms required, end_ms >= start_ms", nil), nil
		}
		if d.Search == nil {
			return envelope.Err(kind, envelope.CodeDependencyFailed, "transcript backend (Postgres) not configured", nil), nil
		}
		pad := req.GetInt("pad_ms", 0)
		if pad < 0 {
			pad = 0
		}
		lang := req.GetString("lang", "")
		limit := clamp(req.GetInt("limit", 10), 10, 50)

		tr, err := d.Catalog.GetTrack(ctx, trackID)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if tr == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such track", map[string]any{"track_id": trackID}), nil
		}
		lo := startMs - pad
		if lo < 0 {
			lo = 0
		}
		hits, err := d.Search.Window(ctx, trackID, lo, endMs+pad, lang, limit)
		if err != nil {
			return envelope.Err(kind, envelope.CodeDependencyFailed, err.Error(), nil), nil
		}
		chunks := make([]map[string]any, 0, len(hits))
		for _, h := range hits {
			ch := map[string]any{"text": h.Text, "lang": h.Lang}
			if h.StartMs != nil {
				ch["start_ms"] = *h.StartMs
			}
			if h.EndMs != nil {
				ch["end_ms"] = *h.EndMs
			}
			chunks = append(chunks, ch)
		}
		logQuery(ctx, kind, "", nil, nil, len(chunks), lang, start)
		return envelope.Result(kind, map[string]any{"count": len(chunks), "chunks": chunks}), nil
	})
}
