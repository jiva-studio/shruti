package mcpsrv

import (
	"context"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	appsearch "github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/application/search"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/envelope"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
)

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
		id := strings.TrimSpace(req.GetString("id", ""))
		if id == "" {
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
		source := strings.TrimSpace(req.GetString("source", ""))
		if source == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "source is required", nil), nil
		}
		lang := req.GetString("lang", "")
		cursor := req.GetString("cursor", "")
		limit := clamp(req.GetInt("limit", 100), 100, 500)
		docKind := req.GetString("kind", "")
		if docKind != "" && !appsearch.IsDocKind(docKind) {
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
