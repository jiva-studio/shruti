package mcpsrv

import (
	"context"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/catalog"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
)

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
		query := strings.TrimSpace(req.GetString("query", ""))
		if query == "" {
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

func registerEntityList(srv *server.MCPServer, kind string, load func(context.Context) (*catalog.EntityDict, error)) {
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
		query := strings.TrimSpace(req.GetString("query", ""))
		if query == "" {
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
	registerEntityList(srv, "author_list", d.Catalog.LoadAuthors)
}
func registerAuthorResolve(srv *server.MCPServer, d *Deps) {
	registerEntityResolve(srv, d, "author_resolve", d.Catalog.LoadAuthors)
}
func registerLocationList(srv *server.MCPServer, d *Deps) {
	registerEntityList(srv, "location_list", d.Catalog.LoadLocations)
}
func registerLocationResolve(srv *server.MCPServer, d *Deps) {
	registerEntityResolve(srv, d, "location_resolve", d.Catalog.LoadLocations)
}
