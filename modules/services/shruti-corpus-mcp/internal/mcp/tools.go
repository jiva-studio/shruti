package mcpsrv

import (
	"context"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/library"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/search"
)

const trgmMinSim = 0.3

// toolTitles are the human-readable display names (MCP `title` annotation)
// clients show instead of the raw underscore tool name.
var toolTitles = map[string]string{
	"search":            "Search",
	"source_get":        "Get book",
	"source_list":       "List books",
	"source_resolve":    "Find book",
	"author_list":       "List authors",
	"author_resolve":    "Find author",
	"location_list":     "List locations",
	"location_resolve":  "Find location",
	"verse_get":         "Get verse",
	"verse_translation": "Get translation",
	"verse_synonyms":    "Word-by-word",
	"verse_list":        "List verses",
	"document_get":      "Get document",
	"document_list":     "List documents",
	"track_get":         "Get lecture",
	"track_list":        "List lectures",
	"transcript_window": "Read transcript",
	"media_get":         "Play video",
	"lecture_excerpt":   "Play excerpt",
	"excerpt_prepare":   "Prepare excerpt audio",
}

// RegisterTools wires the 15 read-only tools plus the two MCP-App render-tools
// (media_get, lecture_excerpt) and their UI resources onto srv.
func RegisterTools(srv *server.MCPServer, d *Deps) {
	registerSearch(srv, d)
	registerSourceGet(srv, d)
	registerSourceList(srv, d)
	registerSourceResolve(srv, d)
	registerAuthorList(srv, d)
	registerAuthorResolve(srv, d)
	registerLocationList(srv, d)
	registerLocationResolve(srv, d)
	registerVerseGet(srv, d)
	registerVerseTranslation(srv, d)
	registerVerseSynonyms(srv, d)
	registerVerseList(srv, d)
	registerDocumentGet(srv, d)
	registerDocumentList(srv, d)
	registerTrackGet(srv, d)
	registerTrackList(srv, d)
	registerTranscriptWindow(srv, d)
	// MCP Apps: the two interactive UI render-tools + their UI resources.
	registerApps(srv, d)
}

// ── search ─────────────────────────────────────────────────────────────────

func chunkKindsForTypes(types []string) ([]string, error) {
	if len(types) == 0 {
		return []string{"verse", "commentary", "prose_chapter", "letter", "track_transcript", "title", "media"}, nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(k string) {
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	for _, t := range types {
		switch strings.ToLower(strings.TrimSpace(t)) {
		case "verse":
			add("verse")
		case "document":
			add("commentary")
			add("prose_chapter")
			add("letter")
		case "track":
			add("track_transcript")
		case "title":
			add("title")
		case "media":
			add("media")
		case "":
			// ignore
		default:
			return nil, &badType{t}
		}
	}
	return out, nil
}

type badType struct{ t string }

func (e *badType) Error() string { return "invalid type: " + e.t }

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
				"track_id+start_ms/end_ms→transcript_window; media_id→media_get to play the clip). "+
				"Every filter is optional. Use min_score to drop weak matches."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Natural-language query.")),
		mcp.WithArray("types", mcp.Description("Subset of verse|document|track|title|media (default all). A `media` hit is a short video clip playable via media_get."), mcp.WithStringItems()),
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
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		query, err := req.RequireString("query")
		if err != nil || strings.TrimSpace(query) == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "query must not be empty", nil), nil
		}
		if d.Search == nil || d.Embed == nil {
			return envelope.Err(kind, envelope.CodeDependencyFailed, "search backend (Postgres/embedding) not configured", nil), nil
		}
		types := req.GetStringSlice("types", nil)
		kinds, err := chunkKindsForTypes(types)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang := req.GetString("lang", "")
		kindFilter := req.GetString("kind", "")
		authorID := req.GetString("author_id", "")
		locationID := req.GetString("location_id", "")
		dateFrom := req.GetString("date_from", "")
		dateTo := req.GetString("date_to", "")
		limit := clamp(req.GetInt("limit", 10), 10, 50)
		minScore := req.GetFloat("min_score", 0)

		sd, ad, ld, err := d.loadDicts(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}

		// Resolve source filter.
		var sourceID string
		sourceParam := req.GetString("source", "")
		if sourceParam != "" {
			id, ok := resolveSourceParam(sd, sourceParam)
			if !ok {
				return envelope.Err(kind, envelope.CodeInvalidArgument, "unknown source: "+sourceParam, map[string]any{"source": sourceParam}), nil
			}
			sourceID = id
		}
		tokens := ""
		if tk := req.GetString("tokens", ""); tk != "" && sourceID != "" {
			tokens = refs.NormalizeToken(tk)
		}

		// If a document-kind filter is set, retrieve only that doc kind.
		if isDocKind(kindFilter) {
			kinds = filterDocKinds(kinds, kindFilter)
		}

		// Track-only search under a reference filter: resolve the citing
		// track_ids up front and push them into the SQL as a c.track_id filter,
		// so the vector/lexical lanes only ever touch relevant chunks. This
		// replaces the expensive over-fetch-then-filter path (which pulled
		// limit×8 hits through HNSW and enriched each before dropping ~all).
		trackOnly := len(kinds) == 1 && kinds[0] == "track_transcript"
		refPrefiltered := trackOnly && sourceID != ""
		var trackIDs []string
		if refPrefiltered {
			ids, terr := d.Catalog.TrackIDsByRef(ctx, sourceID, tokens)
			if terr != nil {
				return envelope.Err(kind, envelope.CodeInternal, terr.Error(), nil), nil
			}
			if len(ids) == 0 {
				// Nothing cites this reference — no DB/embedder work needed.
				filters := searchFilters(sourceParam, tokens, kindFilter, authorID, locationID, dateFrom, dateTo)
				logQuery(ctx, kind, query, filters, types, 0, lang, start)
				return envelope.Result(kind, map[string]any{"count": 0, "hits": []map[string]any{}}), nil
			}
			trackIDs = ids
		}

		// Over-fetch when a post-retrieval attribute filter is active — except
		// the ref-prefiltered path, where the SQL filter already narrows recall.
		hasPostFilter := sourceID != "" || tokens != "" || kindFilter != "" ||
			authorID != "" || locationID != "" || dateFrom != "" || dateTo != ""
		retrieve := limit
		if hasPostFilter && !refPrefiltered {
			retrieve = limit * 8
			if retrieve > 200 {
				retrieve = 200
			}
			if retrieve < 50 {
				retrieve = 50
			}
		}

		vec, eerr := d.Embed.Query(ctx, query)
		if eerr != nil {
			return envelope.Err(kind, envelope.CodeDependencyFailed, "embed query: "+eerr.Error(), nil), nil
		}
		hits, lanes, serr := d.Search.Hybrid(ctx, query, vec, kinds, lang, retrieve, trgmMinSim, trackIDs)
		if serr != nil {
			return envelope.Err(kind, envelope.CodeDependencyFailed, serr.Error(), nil), nil
		}

		trackCache := map[string]*catalog.Track{}
		getTrack := func(id string) (*catalog.Track, error) {
			if t, ok := trackCache[id]; ok {
				return t, nil
			}
			t, err := d.Catalog.GetTrack(ctx, id)
			trackCache[id] = t
			return t, err
		}

		out := make([]map[string]any, 0, limit)
		for _, h := range hits {
			if len(out) >= limit {
				break
			}
			if h.Score < minScore {
				continue
			}
			obj, keep, herr := d.buildSearchHit(ctx, sd, ad, ld, getTrack, h, lang,
				sourceID, tokens, kindFilter, authorID, locationID, dateFrom, dateTo, refPrefiltered)
			if herr != nil {
				return envelope.Err(kind, envelope.CodeInternal, herr.Error(), nil), nil
			}
			if keep {
				out = append(out, obj)
			}
		}

		filters := searchFilters(sourceParam, tokens, kindFilter, authorID, locationID, dateFrom, dateTo)
		logQueryLanes(ctx, kind, query, filters, types, len(out), lang, start, &lanes.VectorMs, &lanes.LexicalMs)
		return envelope.Result(kind, map[string]any{"count": len(out), "hits": out}), nil
	})
}

// searchFilters builds the analytics `filters` map for a search call.
func searchFilters(source, tokens, kindFilter, authorID, locationID, dateFrom, dateTo string) map[string]any {
	filters := map[string]any{}
	putIf(filters, "source", source)
	putIf(filters, "tokens", tokens)
	putIf(filters, "kind", kindFilter)
	putIf(filters, "author_id", authorID)
	putIf(filters, "location_id", locationID)
	putIf(filters, "date_from", dateFrom)
	putIf(filters, "date_to", dateTo)
	return filters
}

func filterDocKinds(kinds []string, keep string) []string {
	var out []string
	for _, k := range kinds {
		if isDocKind(k) && k != keep {
			continue
		}
		out = append(out, k)
	}
	return out
}

// buildSearchHit turns one chunk into a typed hit map, applying post-retrieval
// filters. keep=false drops the hit.
func (d *Deps) buildSearchHit(ctx context.Context, sd *catalog.SourceDict, ad, ld *catalog.EntityDict,
	getTrack func(string) (*catalog.Track, error), h search.Hit, lang string,
	sourceID, tokens, kindFilter, authorID, locationID, dateFrom, dateTo string, refPrefiltered bool,
) (map[string]any, bool, error) {

	effLang := lang
	if effLang == "" {
		effLang = h.Lang
	}
	sid := strOr(h.SourceID)
	tok := strOr(h.Tokens)

	switch h.Kind {
	case "verse", "commentary", "prose_chapter", "letter", "title":
		// Library hit: apply source/tokens; author only for documents; kind
		// only for documents; track-only filters exclude the hit.
		if sourceID != "" && sid != sourceID {
			return nil, false, nil
		}
		if tokens != "" && tok != tokens {
			return nil, false, nil
		}
		if locationID != "" || dateFrom != "" || dateTo != "" {
			return nil, false, nil
		}
		if h.Kind == "verse" || h.Kind == "title" {
			if kindFilter != "" || authorID != "" {
				return nil, false, nil
			}
		} else { // document
			if kindFilter != "" && h.Kind != kindFilter {
				return nil, false, nil
			}
			if authorID != "" && strOr(h.AuthorID) != authorID {
				return nil, false, nil
			}
		}
		human := sd.RefString(sid, tok, effLang)
		obj := map[string]any{
			"score":   round2f(h.Score),
			"ref":     human,
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
		return obj, true, nil

	case "track_transcript":
		tid := strOr(h.TrackID)
		tr, err := getTrack(tid)
		if err != nil {
			return nil, false, err
		}
		if tr == nil {
			return nil, false, nil // hidden/removed track
		}
		if authorID != "" && tr.AuthorID != authorID {
			return nil, false, nil
		}
		if locationID != "" && tr.LocationID != locationID {
			return nil, false, nil
		}
		if dateFrom != "" && tr.Date < dateFrom {
			return nil, false, nil
		}
		if dateTo != "" && tr.Date > dateTo {
			return nil, false, nil
		}
		if kindFilter != "" && tr.Kind() != kindFilter {
			return nil, false, nil
		}
		// When the recall was already pre-filtered to citing tracks (via
		// TrackIDsByRef with the chapter-prefix rule), skip the exact-match
		// TrackHasRef check — it would wrongly drop chapter-prefix hits.
		if sourceID != "" && !refPrefiltered {
			ok, err := d.Catalog.TrackHasRef(ctx, tid, sourceID, tokens)
			if err != nil {
				return nil, false, err
			}
			if !ok {
				return nil, false, nil
			}
		}
		obj := map[string]any{
			"type":     "track",
			"score":    round2f(h.Score),
			"track_id": tid,
			"lang":     h.Lang,
			"snippet":  snippet(h.Text),
			"track":    trackMeta(tr, sd, ad, ld, effLang),
		}
		if h.StartMs != nil {
			obj["start_ms"] = *h.StartMs
		}
		if h.EndMs != nil {
			obj["end_ms"] = *h.EndMs
		}
		return obj, true, nil

	case "media":
		// Standalone media clip. It carries none of the library/track
		// attributes, so any of those filters excludes it.
		if sourceID != "" || tokens != "" || kindFilter != "" ||
			authorID != "" || locationID != "" || dateFrom != "" || dateTo != "" {
			return nil, false, nil
		}
		mediaID := strOr(h.ItemID)
		if mediaID == "" {
			return nil, false, nil
		}
		obj := map[string]any{
			"type":     "media",
			"score":    round2f(h.Score),
			"media_id": mediaID,
			"url":      d.Cfg.MediaBase() + "/public/media/" + mediaID + ".mp4",
			"lang":     h.Lang,
			"snippet":  snippet(h.Text),
		}
		return obj, true, nil
	}
	return nil, false, nil
}

// ── source_get / list / resolve ─────────────────────────────────────────────

func (d *Deps) sourceObject(ctx context.Context, sd *catalog.SourceDict, id, lang string) (map[string]any, error) {
	obj := sourceRefFull(sd, id, lang)
	st, err := d.Library.Stats(ctx, id)
	if err != nil {
		return nil, err
	}
	obj["token_scheme"] = st.TokenScheme
	obj["has_commentary"] = st.HasCommentary
	obj["verse_count"] = st.VerseCount
	return obj, nil
}

func registerSourceGet(srv *server.MCPServer, d *Deps) {
	const kind = "source_get"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Get one book by id or code (\"source_…\" or \"BG\"/\"БГ\")."),
		mcp.WithString("id", mcp.Description("source_id.")),
		mcp.WithString("code", mcp.Description("Book code, e.g. \"BG\" / \"БГ\".")),
		mcp.WithString("lang", mcp.Description("Slim code/name to this locale.")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang := req.GetString("lang", "")
		id := req.GetString("id", "")
		code := req.GetString("code", "")
		if id == "" && code == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "provide id or code", nil), nil
		}
		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		sourceID := id
		if sourceID == "" {
			resolved, ok := sd.ResolveBook(code)
			if !ok {
				return envelope.Err(kind, envelope.CodeNotFound, "unknown book code: "+code, map[string]any{"code": code}), nil
			}
			sourceID = resolved
		}
		if _, ok := sd.Get(sourceID); !ok {
			return envelope.Err(kind, envelope.CodeNotFound, "no such source", map[string]any{"id": sourceID}), nil
		}
		obj, err := d.sourceObject(ctx, sd, sourceID, lang)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		logQuery(ctx, kind, code, nil, nil, 1, lang, start)
		return envelope.Result(kind, obj), nil
	})
}

func registerSourceList(srv *server.MCPServer, d *Deps) {
	const kind = "source_list"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("List all books (Caitanya-caritāmṛta is three sources)."),
		mcp.WithString("lang", mcp.Description("Slim code/name to this locale.")),
		mcp.WithString("cursor", mcp.Description("Pagination cursor (last source id).")),
		mcp.WithNumber("limit", mcp.Description("Max items (default 100, max 500).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang := req.GetString("lang", "")
		cursor := req.GetString("cursor", "")
		limit := clamp(req.GetInt("limit", 100), 100, 500)
		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		order := sd.Order()
		startIdx := 0
		if cursor != "" {
			for i, id := range order {
				if id == cursor {
					startIdx = i + 1
					break
				}
			}
		}
		items := []map[string]any{}
		var next any
		for i := startIdx; i < len(order); i++ {
			if len(items) >= limit {
				next = order[i-1]
				break
			}
			obj, err := d.sourceObject(ctx, sd, order[i], lang)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			items = append(items, obj)
		}
		logQuery(ctx, kind, "", nil, nil, len(items), lang, start)
		return envelope.Result(kind, map[string]any{"items": items, "next_cursor": next}), nil
	})
}

func registerSourceResolve(srv *server.MCPServer, d *Deps) {
	const kind = "source_resolve"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Find a book by name (fuzzy): \"gita\", \"бхагаватам\", \"CC Madhya\"."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Book name or code fragment.")),
		mcp.WithString("lang", mcp.Description("Result language.")),
		mcp.WithNumber("limit", mcp.Description("Max matches (default 5, max 20).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		query, err := req.RequireString("query")
		if err != nil || strings.TrimSpace(query) == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "query must not be empty", nil), nil
		}
		lang := req.GetString("lang", "")
		limit := clamp(req.GetInt("limit", 5), 5, 20)
		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		matches := d.Catalog.ResolveSources(sd, query, lang, limit)
		out := make([]map[string]any, 0, len(matches))
		for _, m := range matches {
			out = append(out, map[string]any{"id": m.ID, "code": m.Code, "name": m.Name, "score": m.Score})
		}
		logQuery(ctx, kind, query, nil, nil, len(out), lang, start)
		return envelope.Result(kind, map[string]any{"matches": out}), nil
	})
}

// ── author / location list + resolve ────────────────────────────────────────

func registerEntityList(srv *server.MCPServer, d *Deps, kind string, load func(context.Context) (*catalog.EntityDict, error)) {
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("List all "+strings.TrimSuffix(kind, "_list")+"s."),
		mcp.WithString("lang", mcp.Description("Slim name to this locale.")),
		mcp.WithString("cursor", mcp.Description("Pagination cursor (last id).")),
		mcp.WithNumber("limit", mcp.Description("Max items (default 100, max 500).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang := req.GetString("lang", "")
		cursor := req.GetString("cursor", "")
		limit := clamp(req.GetInt("limit", 100), 100, 500)
		dict, err := load(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		order := dict.Order()
		startIdx := 0
		if cursor != "" {
			for i, id := range order {
				if id == cursor {
					startIdx = i + 1
					break
				}
			}
		}
		items := []map[string]any{}
		var next any
		for i := startIdx; i < len(order); i++ {
			if len(items) >= limit {
				next = order[i-1]
				break
			}
			e, _ := dict.Get(order[i])
			items = append(items, map[string]any{"id": e.ID, "name": nameField(e.Names, lang)})
		}
		logQuery(ctx, kind, "", nil, nil, len(items), lang, start)
		return envelope.Result(kind, map[string]any{"items": items, "next_cursor": next}), nil
	})
}

func registerEntityResolve(srv *server.MCPServer, d *Deps, kind string, load func(context.Context) (*catalog.EntityDict, error)) {
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Find a "+strings.TrimSuffix(kind, "_resolve")+" by name (fuzzy)."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Name fragment.")),
		mcp.WithString("lang", mcp.Description("Result language.")),
		mcp.WithNumber("limit", mcp.Description("Max matches (default 5, max 20).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		query, err := req.RequireString("query")
		if err != nil || strings.TrimSpace(query) == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "query must not be empty", nil), nil
		}
		lang := req.GetString("lang", "")
		limit := clamp(req.GetInt("limit", 5), 5, 20)
		dict, err := load(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		matches := d.Catalog.ResolveEntities(dict, query, lang, limit)
		out := make([]map[string]any, 0, len(matches))
		for _, m := range matches {
			out = append(out, map[string]any{"id": m.ID, "name": m.Name, "score": m.Score})
		}
		logQuery(ctx, kind, query, nil, nil, len(out), lang, start)
		return envelope.Result(kind, map[string]any{"matches": out}), nil
	})
}

func registerAuthorList(srv *server.MCPServer, d *Deps) {
	registerEntityList(srv, d, "author_list", d.Catalog.LoadAuthors)
}
func registerAuthorResolve(srv *server.MCPServer, d *Deps) {
	registerEntityResolve(srv, d, "author_resolve", d.Catalog.LoadAuthors)
}
func registerLocationList(srv *server.MCPServer, d *Deps) {
	registerEntityList(srv, d, "location_list", d.Catalog.LoadLocations)
}
func registerLocationResolve(srv *server.MCPServer, d *Deps) {
	registerEntityResolve(srv, d, "location_resolve", d.Catalog.LoadLocations)
}

// ── verse_get / verse_list ──────────────────────────────────────────────────

func registerVerseGet(srv *server.MCPServer, d *Deps) {
	const kind = "verse_get"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Get a verse: original script (Devanagari/Bengali) + IAST transliteration, both as line arrays. "+
			"With lang, also returns the canonical translation inline plus an `alternatives` manifest of other "+
			"translation kinds in that language (fetch their text with verse_translation, word-by-word with verse_synonyms). "+
			"Address by ref (\"BG 2.13\"), source+tokens, or verse id."),
		mcp.WithString("ref", mcp.Description("Reference string, e.g. \"BG 2.13\".")),
		mcp.WithString("source", mcp.Description("Book code / source_id (with tokens).")),
		mcp.WithString("tokens", mcp.Description("Position within the book (with source).")),
		mcp.WithString("id", mcp.Description("verse_id.")),
		mcp.WithString("lang", mcp.Description("Answer language. Set it to get the canonical translation + alternatives manifest.")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		lang := req.GetString("lang", "")
		id := req.GetString("id", "")
		ref := req.GetString("ref", "")
		source := req.GetString("source", "")
		tokens := req.GetString("tokens", "")

		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		ad, err := d.Catalog.LoadAuthors(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}

		if id != "" {
			v, err := d.Library.GetByID(ctx, id)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			if v == nil {
				return envelope.Err(kind, envelope.CodeNotFound, "no such verse", map[string]any{"id": id, "stage": "verse"}), nil
			}
			obj, err := d.verseObjectWithCovers(ctx, sd, ad, v, lang)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
			return envelope.Result(kind, obj), nil
		}

		if ref == "" && source == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "provide ref, source+tokens, or id", nil), nil
		}
		sourceID, tok, stage, ok := resolveReference(sd, ref, source, tokens)
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, "unresolvable reference", map[string]any{"ref": humanRef(ref, source, tokens), "stage": stage}), nil
		}
		v, err := d.Library.GetByRef(ctx, sourceID, tok)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if v == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such verse", map[string]any{"ref": humanRef(ref, source, tokens), "stage": "verse"}), nil
		}
		obj, err := d.verseObjectWithCovers(ctx, sd, ad, v, lang)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
		return envelope.Result(kind, obj), nil
	})
}

// verseObjectWithCovers builds the verse_get payload: the language-independent
// skeleton, a `covers` span for merged verses, and — when lang is set — the
// canonical translation inline plus an `alternatives` manifest (other kinds in
// that language, metadata only; fetch their text via verse_translation).
func (d *Deps) verseObjectWithCovers(ctx context.Context, sd *catalog.SourceDict, ad *catalog.EntityDict, v *library.Verse, lang string) (map[string]any, error) {
	obj := verseObject(sd, v, lang)
	covers, err := d.Library.VerseCovers(ctx, v)
	if err != nil {
		return nil, err
	}
	if covers != "" {
		obj["covers"] = covers
	}
	if lang == "" {
		return obj, nil
	}
	metas, err := d.Library.TranslationMetas(ctx, v.ID, lang)
	if err != nil {
		return nil, err
	}
	alternatives := []map[string]any{}
	for _, m := range metas {
		if m.Kind == "canonical" {
			t, err := d.Library.GetTranslation(ctx, v.ID, lang, "canonical")
			if err != nil {
				return nil, err
			}
			if t != nil {
				obj["kind"] = "canonical"
				obj["translation"] = t.Text
				if a := authorRef(ad, t.AuthorID, lang); a != nil {
					obj["author"] = a
				}
			}
			continue
		}
		alt := map[string]any{"kind": m.Kind}
		if a := authorRef(ad, m.AuthorID, lang); a != nil {
			alt["author"] = a
		}
		if m.Note != "" {
			alt["note"] = m.Note
		}
		alternatives = append(alternatives, alt)
	}
	obj["alternatives"] = alternatives
	return obj, nil
}

func registerVerseList(srv *server.MCPServer, d *Deps) {
	const kind = "verse_list"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("List the verses of a book / chapter. Skips .0 chapter summaries; "+
			"collapses merged verses into one item with a covers span."),
		mcp.WithString("source", mcp.Required(), mcp.Description("Book code / source_id.")),
		mcp.WithString("tokens", mcp.Description("Chapter/canto prefix, e.g. \"2\" or \"5.5\".")),
		mcp.WithString("lang", mcp.Description("Preview language.")),
		mcp.WithString("cursor", mcp.Description("Pagination cursor (last tokens).")),
		mcp.WithNumber("limit", mcp.Description("Max items (default 100, max 500).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		source, err := req.RequireString("source")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "source is required", nil), nil
		}
		lang := req.GetString("lang", "")
		cursor := req.GetString("cursor", "")
		limit := clamp(req.GetInt("limit", 100), 100, 500)
		prefix := ""
		if tk := req.GetString("tokens", ""); tk != "" {
			prefix = refs.NormalizeToken(tk)
		}
		sd, err := d.Catalog.LoadSources(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		sourceID, ok := resolveSourceParam(sd, source)
		if !ok {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "unknown source: "+source, map[string]any{"source": source}), nil
		}
		all, err := d.Library.ListVerses(ctx, sourceID, prefix)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		items := []map[string]any{}
		var next any
		for _, it := range all {
			if cursor != "" && refs.CompareTokens(it.Tokens, cursor) <= 0 {
				continue
			}
			if len(items) >= limit {
				next = items[len(items)-1]["tokens"]
				break
			}
			human := it.Tokens
			if it.Covers != "" {
				sp := strings.SplitN(it.Covers, "-", 2)
				if len(sp) == 2 {
					human = refs.CompressRange(sp[0], sp[1])
				}
			}
			obj := map[string]any{
				"id":                  it.ID,
				"ref":                 sd.RefString(sourceID, human, lang),
				"source":              sourceRefSmall(sd, sourceID, lang),
				"tokens":              it.Tokens,
				"translation_preview": preview(catalogPick(it.Translations, lang), 200),
			}
			if it.Covers != "" {
				obj["covers"] = it.Covers
			}
			items = append(items, obj)
		}
		logQuery(ctx, kind, "", map[string]any{"source": source, "tokens": prefix}, nil, len(items), lang, start)
		return envelope.Result(kind, map[string]any{"items": items, "next_cursor": next}), nil
	})
}

// ── document_get / document_list ────────────────────────────────────────────

func registerDocumentGet(srv *server.MCPServer, d *Deps) {
	const kind = "document_get"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("Get a document (commentary/prose_chapter/letter) by id."),
		mcp.WithString("id", mcp.Required(), mcp.Description("doc_id.")),
		mcp.WithString("lang", mcp.Description("Slim bodies to this locale.")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "id is required", nil), nil
		}
		lang := req.GetString("lang", "")
		sd, ad, _, err := d.loadDicts(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		doc, err := d.Library.GetDocument(ctx, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if doc == nil {
			return envelope.Err(kind, envelope.CodeNotFound, "no such document", map[string]any{"id": id}), nil
		}
		logQuery(ctx, kind, "", nil, nil, 1, lang, start)
		return envelope.Result(kind, documentObject(sd, ad, doc, lang)), nil
	})
}

func registerDocumentList(srv *server.MCPServer, d *Deps) {
	const kind = "document_list"
	t := mcp.NewTool(kind,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithTitleAnnotation(toolTitles[kind]),
		mcp.WithRawOutputSchema(outputSchemaFor(kind)),
		mcp.WithDescription("List documents at a reference / in a book. A verse's purport = "+
			"document_list(source, tokens, kind:\"commentary\")."),
		mcp.WithString("source", mcp.Required(), mcp.Description("Book code / source_id.")),
		mcp.WithString("tokens", mcp.Description("A specific reference; omit for the whole book.")),
		mcp.WithString("kind", mcp.Description(docKinds+".")),
		mcp.WithString("author_id", mcp.Description("Commentator.")),
		mcp.WithString("lang", mcp.Description("Slim bodies to this locale.")),
		mcp.WithString("cursor", mcp.Description("Pagination cursor (last doc id).")),
		mcp.WithNumber("limit", mcp.Description("Max items (default 100, max 500).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		source, err := req.RequireString("source")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "source is required", nil), nil
		}
		lang := req.GetString("lang", "")
		cursor := req.GetString("cursor", "")
		limit := clamp(req.GetInt("limit", 100), 100, 500)
		docKind := req.GetString("kind", "")
		if docKind != "" && !isDocKind(docKind) {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "kind must be one of "+docKinds, nil), nil
		}
		sd, ad, _, err := d.loadDicts(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		sourceID, ok := resolveSourceParam(sd, source)
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, "unknown source: "+source, map[string]any{"source": source, "stage": "source"}), nil
		}
		tokens := ""
		if tk := req.GetString("tokens", ""); tk != "" {
			tokens = refs.NormalizeToken(tk)
		}
		docs, err := d.Library.ListDocuments(ctx, buildDocFilter(sourceID, tokens, docKind, req.GetString("author_id", ""), cursor, limit+1))
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		var next any
		if len(docs) > limit {
			next = docs[limit-1].ID
			docs = docs[:limit]
		}
		items := make([]map[string]any, 0, len(docs))
		for _, doc := range docs {
			items = append(items, documentObject(sd, ad, doc, lang))
		}
		logQuery(ctx, kind, "", map[string]any{"source": source, "tokens": tokens, "kind": docKind}, nil, len(items), lang, start)
		return envelope.Result(kind, map[string]any{"items": items, "next_cursor": next}), nil
	})
}

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
		trackID, err := req.RequireString("track_id")
		if err != nil {
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
		obj := trackMeta(tr, sd, ad, ld, lang)
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
			items = append(items, trackMeta(tr, sd, ad, ld, lang))
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
		trackID, err := req.RequireString("track_id")
		if err != nil {
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
