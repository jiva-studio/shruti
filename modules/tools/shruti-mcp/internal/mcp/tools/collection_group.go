package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectiongroupcrud"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// CollectionGroupCRUDDeps wires `collection_group.*` tools to the use case.
type CollectionGroupCRUDDeps struct {
	UseCase collectiongroupcrud.UseCase
}

// RegisterCollectionGroupCRUD registers all 9 collection-group tools:
//
//	collection_group.create / .update / .get / .list / .delete / .delete_locale /
//	collection_group.collections.set / .add / .remove
func RegisterCollectionGroupCRUD(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	registerGroupCreate(s, deps)
	registerGroupUpdate(s, deps)
	registerGroupGet(s, deps)
	registerGroupList(s, deps)
	registerGroupDelete(s, deps)
	registerGroupDeleteLocale(s, deps)
	registerGroupCollectionsSet(s, deps)
	registerGroupCollectionsAdd(s, deps)
	registerGroupCollectionsRemove(s, deps)
}

func registerGroupCreate(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.create"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(`Create a collection-group locale row (a named, ordered shelf of collections, e.g. "Для начинающих"). id optional: omit to mint group_<12 alnum>; supply an existing id to add a second locale.`),
		mcp.WithString("id", mcp.Description("Existing group id (second-locale create). Empty = mint new.")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Locale code (ru / en).")),
		mcp.WithString("name", mcp.Required(), mcp.Description("Group name in this locale.")),
		mcp.WithString("description", mcp.Description("Optional group description.")),
		mcp.WithString("meta", mcp.Description("Optional raw JSON blob for forward-compatible fields.")),
		mcp.WithNumber("sort_order", mcp.Description("ASC display key (default 0).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		name, err := req.RequireString("name")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		in := collectiongroupcrud.CreateInput{
			ID:          req.GetString("id", ""),
			Language:    lang,
			Name:        name,
			Description: req.GetString("description", ""),
			Meta:        req.GetString("meta", ""),
			SortOrder:   int(req.GetFloat("sort_order", 0)),
		}
		id, err := deps.UseCase.Create(ctx, in)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{
			"id": id, "language": lang, "name": name,
			"description": in.Description, "sort_order": in.SortOrder,
		}), nil
	})
}

func registerGroupUpdate(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.update"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Patch one (group id, language) locale. Only supplied fields change."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("name"),
		mcp.WithString("description"),
		mcp.WithString("meta"),
		mcp.WithNumber("sort_order"),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		args := req.GetArguments()
		in := collectiongroupcrud.UpdateInput{ID: id, Language: lang}
		if v, ok := args["name"].(string); ok {
			in.Name = &v
		}
		if v, ok := args["description"].(string); ok {
			in.Description = &v
		}
		if v, ok := args["meta"].(string); ok {
			in.Meta = &v
		}
		if v, ok := args["sort_order"].(float64); ok {
			n := int(v)
			in.SortOrder = &n
		}
		if err := deps.UseCase.Update(ctx, in); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func registerGroupGet(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Get the group collapsed across locales plus its collection membership per locale."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		g, collections, ok, err := deps.UseCase.Get(ctx, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("collection_group/%s not found", id), nil), nil
		}
		return envelope.Result(kind, map[string]any{"group": groupToWire(g), "collections": collections}), nil
	})
}

func registerGroupList(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List collection groups filtered by language. Returns groups without their membership."),
		mcp.WithString("language", mcp.Description("Filter to a single locale.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 100).")),
		mcp.WithString("cursor", mcp.Description("Opaque id cursor.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		opts := catalog.CollectionGroupListOpts{Limit: int(req.GetFloat("limit", 0)), Cursor: req.GetString("cursor", "")}
		if v, ok := args["language"].(string); ok && v != "" {
			opts.Language = &v
		}
		groups, err := deps.UseCase.List(ctx, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		out := make([]map[string]any, 0, len(groups))
		for _, g := range groups {
			out = append(out, groupToWire(g))
		}
		return envelope.Result(kind, map[string]any{"groups": out}), nil
	})
}

func registerGroupDelete(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.delete"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Delete all locales of a group (cascades its items)."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.Delete(ctx, id); err != nil {
			return envelope.Err(kind, envelope.CodeNotFound, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"deleted": true}), nil
	})
}

func registerGroupDeleteLocale(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.delete_locale"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Delete one locale row of a group. The other locale is preserved."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.DeleteLocale(ctx, id, lang); err != nil {
			return envelope.Err(kind, envelope.CodeNotFound, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"deleted": true}), nil
	})
}

func registerGroupCollectionsSet(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.collections.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Replace the full ordered collection membership of (group id, language). Each collection must exist in that language."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithArray("collection_ids", mcp.Required(), mcp.Description("Ordered collection ids (position 0 first).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		cols, err := requireStringList(req, "collection_ids")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.SetCollections(ctx, id, lang, cols); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"id": id, "language": lang, "count": len(cols)}), nil
	})
}

func registerGroupCollectionsAdd(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.collections.add"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Add one collection to a group locale at `position` (default append). Idempotent."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("collection_id", mcp.Required()),
		mcp.WithNumber("position", mcp.Description("0-based insertion index (default append).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		collectionID, err := req.RequireString("collection_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		args := req.GetArguments()
		var pos *int
		if v, ok := args["position"].(float64); ok {
			n := int(v)
			pos = &n
		}
		if err := deps.UseCase.AddCollection(ctx, id, lang, collectionID, pos); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func registerGroupCollectionsRemove(s *server.MCPServer, deps CollectionGroupCRUDDeps) {
	kind := "collection_group.collections.remove"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Remove one collection from a group locale. Idempotent."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("collection_id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		collectionID, err := req.RequireString("collection_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.RemoveCollection(ctx, id, lang, collectionID); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func groupToWire(g catalog.CollectionGroup) map[string]any {
	return map[string]any{
		"id":           g.Id,
		"names":        g.Names,
		"descriptions": g.Descriptions,
		"meta":         g.Meta,
		"sort_order":   g.SortOrder,
	}
}
