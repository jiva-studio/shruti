package mcpsrv

import (
	"context"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/envelope"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/refs"
	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/search"
)

const trgmMinSim = 0.3

// RegisterTools wires all 15 read-only tools onto srv.
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
	registerVerseList(srv, d)
	registerDocumentGet(srv, d)
	registerDocumentList(srv, d)
	registerTrackGet(srv, d)
	registerTrackList(srv, d)
	registerTranscriptWindow(srv, d)
}

// ── search ─────────────────────────────────────────────────────────────────

func chunkKindsForTypes(types []string) ([]string, error) {
	if len(types) == 0 {
		return []string{"verse", "commentary", "prose_chapter", "letter", "track_transcript", "title"}, nil
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
		mcp.WithDescription(
			"Semantic + lexical search over the corpus. Returns verses, documents, "+
				"track passages and titles matching a natural-language query, each with the "+
				"id needed to fetch the full record (verse_id→verse.get, document_id→document.get, "+
				"track_id+start_ms/end_ms→transcript.window). Every filter is optional."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Natural-language query.")),
		mcp.WithArray("types", mcp.Description("Subset of verse|document|track|title (default all)."), mcp.WithStringItems()),
		mcp.WithString("source", mcp.Description("Restrict to a book (\"BG\" / source_id).")),
		mcp.WithString("tokens", mcp.Description("With source: restrict to a reference (verse tokens; for tracks, tracks citing it).")),
		mcp.WithString("kind", mcp.Description("Document ("+docKinds+") or track (lecture|conversation) subtype.")),
		mcp.WithString("author_id", mcp.Description("Commentator (document) / speaker (track).")),
		mcp.WithString("location_id", mcp.Description("Track location.")),
		mcp.WithString("date_from", mcp.Description("Track date lower bound YYYY-MM-DD.")),
		mcp.WithString("date_to", mcp.Description("Track date upper bound YYYY-MM-DD.")),
		mcp.WithString("lang", mcp.Description("Result language (ISO-639-1).")),
		mcp.WithNumber("limit", mcp.Description("Max results (default 10, max 50).")),
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

		// Over-fetch when any post-retrieval attribute filter is active.
		hasPostFilter := sourceID != "" || tokens != "" || kindFilter != "" ||
			authorID != "" || locationID != "" || dateFrom != "" || dateTo != ""
		retrieve := limit
		if hasPostFilter {
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
		hits, serr := d.Search.Hybrid(ctx, query, vec, kinds, lang, retrieve, trgmMinSim)
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
			obj, keep, herr := d.buildSearchHit(ctx, sd, ad, ld, getTrack, h, lang,
				sourceID, tokens, kindFilter, authorID, locationID, dateFrom, dateTo)
			if herr != nil {
				return envelope.Err(kind, envelope.CodeInternal, herr.Error(), nil), nil
			}
			if keep {
				out = append(out, obj)
			}
		}

		filters := map[string]any{}
		putIf(filters, "source", sourceParam)
		putIf(filters, "tokens", tokens)
		putIf(filters, "kind", kindFilter)
		putIf(filters, "author_id", authorID)
		putIf(filters, "location_id", locationID)
		putIf(filters, "date_from", dateFrom)
		putIf(filters, "date_to", dateTo)
		logQuery(ctx, kind, query, filters, types, len(out), lang, start)
		return envelope.Result(kind, map[string]any{"count": len(out), "hits": out}), nil
	})
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
	sourceID, tokens, kindFilter, authorID, locationID, dateFrom, dateTo string,
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
		if sourceID != "" {
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
	}
	return nil, false, nil
}

// ── source.get / list / resolve ─────────────────────────────────────────────

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
	const kind = "source.get"
	t := mcp.NewTool(kind,
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
	const kind = "source.list"
	t := mcp.NewTool(kind,
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
	const kind = "source.resolve"
	t := mcp.NewTool(kind,
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
		mcp.WithDescription("List all "+strings.TrimSuffix(kind, ".list")+"s."),
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
		mcp.WithDescription("Find a "+strings.TrimSuffix(kind, ".resolve")+" by name (fuzzy)."),
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
	registerEntityList(srv, d, "author.list", d.Catalog.LoadAuthors)
}
func registerAuthorResolve(srv *server.MCPServer, d *Deps) {
	registerEntityResolve(srv, d, "author.resolve", d.Catalog.LoadAuthors)
}
func registerLocationList(srv *server.MCPServer, d *Deps) {
	registerEntityList(srv, d, "location.list", d.Catalog.LoadLocations)
}
func registerLocationResolve(srv *server.MCPServer, d *Deps) {
	registerEntityResolve(srv, d, "location.resolve", d.Catalog.LoadLocations)
}

// ── verse.get / verse.list ──────────────────────────────────────────────────

func registerVerseGet(srv *server.MCPServer, d *Deps) {
	const kind = "verse.get"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Get a verse: original (Devanagari/Bengali) + stored IAST transliteration + translation. "+
			"Address by ref (\"BG 2.13\"), source+tokens, or verse id."),
		mcp.WithString("ref", mcp.Description("Reference string, e.g. \"BG 2.13\".")),
		mcp.WithString("source", mcp.Description("Book code / source_id (with tokens).")),
		mcp.WithString("tokens", mcp.Description("Position within the book (with source).")),
		mcp.WithString("id", mcp.Description("verse_id.")),
		mcp.WithString("lang", mcp.Description("If set: single translation; else a translations map.")),
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

		if id != "" {
			v, err := d.Library.GetByID(ctx, id)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			if v == nil {
				return envelope.Err(kind, envelope.CodeNotFound, "no such verse", map[string]any{"id": id, "stage": "verse"}), nil
			}
			logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
			return envelope.Result(kind, verseObject(sd, v, lang)), nil
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
		logQuery(ctx, kind, ref, nil, nil, 1, lang, start)
		return envelope.Result(kind, verseObject(sd, v, lang)), nil
	})
}

func registerVerseList(srv *server.MCPServer, d *Deps) {
	const kind = "verse.list"
	t := mcp.NewTool(kind,
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

// ── document.get / document.list ────────────────────────────────────────────

func registerDocumentGet(srv *server.MCPServer, d *Deps) {
	const kind = "document.get"
	t := mcp.NewTool(kind,
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
	const kind = "document.list"
	t := mcp.NewTool(kind,
		mcp.WithDescription("List documents at a reference / in a book. A verse's purport = "+
			"document.list(source, tokens, kind:\"commentary\")."),
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

// ── track.get / track.list / transcript.window ──────────────────────────────

func registerTrackGet(srv *server.MCPServer, d *Deps) {
	const kind = "track.get"
	t := mcp.NewTool(kind,
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
	const kind = "track.list"
	t := mcp.NewTool(kind,
		mcp.WithDescription("List tracks, filterable by reference (source[+tokens] = tracks citing it), "+
			"author/location/kind/date/lang. No filter ⇒ recent tracks (date desc)."),
		mcp.WithString("source", mcp.Description("Book code / source_id — tracks citing this book.")),
		mcp.WithString("tokens", mcp.Description("With source: tracks citing that exact verse.")),
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
	const kind = "transcript.window"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Read a track's transcript around a time window (from a search track hit or track.list). "+
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
