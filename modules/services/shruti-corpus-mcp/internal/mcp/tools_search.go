package mcpsrv

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	appsearch "github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/application/search"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
)

const trgmMinSim = 0.3

// searchUseCase returns the search planner, or nil when Postgres or the
// embedder is not configured.
func (d *Deps) searchUseCase() *appsearch.UseCase {
	if d.Search == nil || d.Embed == nil {
		return nil
	}
	return &appsearch.UseCase{Embed: d.Embed, Retrieve: d.Search, Tracks: d.Catalog, TrgmMinSim: trgmMinSim}
}

func registerSearch(srv *server.MCPServer, d *Deps) {
	const kind = "search"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription(
			"Semantic + lexical search over the corpus. Returns verses, documents, "+
				"track passages and titles matching a natural-language query, each with the "+
				"id needed to fetch the full record (verse_id→verse_get, document_id→document_get, "+
				"track_id+start_ms/end_ms→transcript_window; media_id→media_render to play the clip). "+
				"Every filter is optional. Use min_score to drop weak matches."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Natural-language query.")),
		mcp.WithArray("types", mcp.Description("Subset of verse|document|track|title|media (default all). A `media` hit is a short video clip playable via media_render."), mcp.WithStringItems()),
		mcp.WithString("source", mcp.Description("Restrict to a book (\"BG\" / source_id).")),
		mcp.WithString("tokens", mcp.Description("With source, restrict to a reference. A bare chapter number covers the WHOLE chapter (\"7\" = all of BG ch 7; \"5.5\" = SB canto 5 ch 5); add the verse for one verse (\"7.1\"). For tracks it means tracks citing that chapter/verse.")),
		mcp.WithString("kind", mcp.Description("Document ("+docKinds+") or track (lecture|conversation) subtype.")),
		mcp.WithString("author_id", mcp.Description("Commentator (document) / speaker (track).")),
		mcp.WithString("location_id", mcp.Description("Track location.")),
		mcp.WithString("date_from", mcp.Description("Track date lower bound YYYY-MM-DD.")),
		mcp.WithString("date_to", mcp.Description("Track date upper bound YYYY-MM-DD.")),
		mcp.WithString("lang", mcp.Description("Result language (ISO-639-1).")),
		mcp.WithNumber("limit", mcp.Description("Max results (default 10, max 50).")),
		mcp.WithNumber("min_score", mcp.Description("Drop hits scoring below this cosine floor (0..1, default 0 = no floor).")),
	)
	uc := d.searchUseCase()
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		query := strings.TrimSpace(req.GetString("query", ""))
		if query == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "query must not be empty", nil), nil
		}
		if uc == nil {
			return envelope.Err(kind, envelope.CodeDependencyFailed, "search backend (Postgres/embedding) not configured", nil), nil
		}
		sreq := appsearch.Request{
			Query:      query,
			Types:      req.GetStringSlice("types", nil),
			Kind:       req.GetString("kind", ""),
			AuthorID:   req.GetString("author_id", ""),
			LocationID: req.GetString("location_id", ""),
			DateFrom:   req.GetString("date_from", ""),
			DateTo:     req.GetString("date_to", ""),
			Lang:       req.GetString("lang", ""),
			Limit:      clamp(req.GetInt("limit", 10), 10, 50),
			MinScore:   req.GetFloat("min_score", 0),
		}
		if _, err := appsearch.ChunkKindsForTypes(sreq.Types); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}

		sd, ad, ld, err := d.loadDicts(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		sourceParam := req.GetString("source", "")
		if sourceParam != "" {
			id, ok := resolveSourceParam(sd, sourceParam)
			if !ok {
				return envelope.Err(kind, envelope.CodeInvalidArgument, "unknown source: "+sourceParam, map[string]any{"source": sourceParam}), nil
			}
			sreq.SourceID = id
		}
		if tk := req.GetString("tokens", ""); tk != "" && sreq.SourceID != "" {
			sreq.Tokens = refs.NormalizeToken(tk)
		}

		res, err := uc.Run(ctx, sreq)
		var dep *appsearch.DependencyError
		switch {
		case errors.As(err, &dep):
			return envelope.Err(kind, envelope.CodeDependencyFailed, dep.Error(), nil), nil
		case errors.Is(err, appsearch.ErrInvalidArgument):
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		case err != nil:
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}

		out := make([]map[string]any, 0, len(res.Hits))
		for _, h := range res.Hits {
			out = append(out, d.searchHitObject(sd, ad, ld, h, sreq.Lang))
		}
		filters := searchFilters(sourceParam, sreq)
		if res.Retrieved {
			logQueryLanes(ctx, kind, query, filters, sreq.Types, len(out), sreq.Lang, start, &res.Lanes.VectorMs, &res.Lanes.LexicalMs)
		} else {
			logQuery(ctx, kind, query, filters, sreq.Types, len(out), sreq.Lang, start)
		}
		return envelope.Result(kind, map[string]any{"count": len(out), "hits": out}), nil
	})
}

// searchFilters builds the analytics `filters` map for a search call.
func searchFilters(source string, r appsearch.Request) map[string]any {
	filters := map[string]any{}
	putIf(filters, "source", source)
	putIf(filters, "tokens", r.Tokens)
	putIf(filters, "kind", r.Kind)
	putIf(filters, "author_id", r.AuthorID)
	putIf(filters, "location_id", r.LocationID)
	putIf(filters, "date_from", r.DateFrom)
	putIf(filters, "date_to", r.DateTo)
	return filters
}

// searchHitObject renders one kept hit in the search output shape.
func (d *Deps) searchHitObject(sd *catalog.SourceDict, ad, ld *catalog.EntityDict, hit appsearch.Hit, lang string) map[string]any {
	h := hit.Chunk
	effLang := lang
	if effLang == "" {
		effLang = h.Lang
	}
	switch h.Kind {
	case "track_transcript":
		obj := map[string]any{
			"type":     "track",
			"score":    round2f(h.Score),
			"track_id": strOr(h.TrackID),
			"lang":     h.Lang,
			"snippet":  snippet(h.Text),
			"track":    trackMeta(hit.Track, ad, ld, effLang),
		}
		if h.StartMs != nil {
			obj["start_ms"] = *h.StartMs
		}
		if h.EndMs != nil {
			obj["end_ms"] = *h.EndMs
		}
		return obj
	case "media":
		mediaID := strOr(h.ItemID)
		return map[string]any{
			"type":     "media",
			"score":    round2f(h.Score),
			"media_id": mediaID,
			"url":      d.Cfg.MediaBase() + "/public/media/" + mediaID + ".mp4",
			"lang":     h.Lang,
			"snippet":  snippet(h.Text),
		}
	}
	sid, tok := strOr(h.SourceID), strOr(h.Tokens)
	obj := map[string]any{
		"score":   round2f(h.Score),
		"ref":     sd.RefString(sid, tok, effLang),
		"source":  sourceRefSmall(sd, sid, effLang),
		"tokens":  tok,
		"snippet": snippet(h.Text),
	}
	switch h.Kind {
	case "verse":
		obj["type"] = "verse"
		obj["verse_id"] = strOr(h.ItemID)
	case "title":
		obj["type"] = "title"
	default:
		obj["type"] = "document"
		obj["kind"] = h.Kind
		obj["document_id"] = strOr(h.ItemID)
		if a := authorRef(ad, strOr(h.AuthorID), effLang); a != nil {
			obj["author"] = a
		}
	}
	return obj
}
