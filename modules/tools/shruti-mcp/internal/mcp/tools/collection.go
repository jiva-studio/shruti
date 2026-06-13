package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectioncrud"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// CollectionCRUDDeps wires `collection.*` tools to the collectioncrud use case.
type CollectionCRUDDeps struct {
	UseCase collectioncrud.UseCase
}

// RegisterCollectionCRUD registers all 9 starter-collection tools:
//
//	collection.create / collection.update / collection.get / collection.list /
//	collection.delete / collection.delete_locale /
//	collection.tracks.set / collection.tracks.add / collection.tracks.remove
//
// All sync; envelope shape `{ok, kind, result}`.
func RegisterCollectionCRUD(s *server.MCPServer, deps CollectionCRUDDeps) {
	registerCollectionCreate(s, deps)
	registerCollectionUpdate(s, deps)
	registerCollectionGet(s, deps)
	registerCollectionList(s, deps)
	registerCollectionDelete(s, deps)
	registerCollectionDeleteLocale(s, deps)
	registerCollectionTracksSet(s, deps)
	registerCollectionTracksAdd(s, deps)
	registerCollectionTracksRemove(s, deps)
}

func registerCollectionCreate(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.create"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(`Create a starter-collection locale row. id is optional: omit to mint a new pack_<12 alnum>; supply an existing id to add a second locale to an existing collection.`),
		mcp.WithString("id", mcp.Description("Existing collection id (for second-locale create). Empty/omitted = mint new.")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Locale code (e.g. ru / en).")),
		mcp.WithString("name", mcp.Required(), mcp.Description("Human-readable collection name in this locale.")),
		mcp.WithBoolean("featured", mcp.Description("Show on mobile empty-state Home (default false).")),
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
		in := collectioncrud.CreateInput{
			ID:        req.GetString("id", ""),
			Language:  lang,
			Name:      name,
			Featured:  req.GetBool("featured", false),
			SortOrder: int(req.GetFloat("sort_order", 0)),
		}
		id, err := deps.UseCase.Create(ctx, in)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{
			"id":         id,
			"language":   lang,
			"name":       name,
			"featured":   in.Featured,
			"sort_order": in.SortOrder,
		}), nil
	})
}

func registerCollectionUpdate(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.update"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Patch one (collection.id, language) locale. Only fields you supply are changed."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("name"),
		mcp.WithBoolean("featured"),
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
		in := collectioncrud.UpdateInput{ID: id, Language: lang}
		if v, ok := args["name"].(string); ok {
			in.Name = &v
		}
		if v, ok := args["featured"].(bool); ok {
			in.Featured = &v
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

func registerCollectionGet(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Get the collection collapsed across locales plus its track membership per locale."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		collection, tracks, ok, err := deps.UseCase.Get(ctx, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("collection/%s not found", id), nil), nil
		}
		return envelope.Result(kind, map[string]any{
			"collection": collectionToWire(collection),
			"tracks":     tracks,
		}), nil
	})
}

func registerCollectionList(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List collections filtered by language / featured. Returns collections without their track membership for compact responses."),
		mcp.WithString("language", mcp.Description("Filter to a single locale.")),
		mcp.WithBoolean("featured", mcp.Description("If set, only featured=true (or =false) rows are returned.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 100).")),
		mcp.WithString("cursor", mcp.Description("Opaque id cursor for pagination.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		opts := catalog.CollectionListOpts{
			Limit:  int(req.GetFloat("limit", 0)),
			Cursor: req.GetString("cursor", ""),
		}
		if v, ok := args["language"].(string); ok && v != "" {
			opts.Language = &v
		}
		if v, ok := args["featured"].(bool); ok {
			opts.Featured = &v
		}
		collections, err := deps.UseCase.List(ctx, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		out := make([]map[string]any, 0, len(collections))
		for _, p := range collections {
			out = append(out, collectionToWire(p))
		}
		return envelope.Result(kind, map[string]any{"collections": out}), nil
	})
}

func registerCollectionDelete(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.delete"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Delete all locales of a collection (cascades collection_tracks)."),
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

func registerCollectionDeleteLocale(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.delete_locale"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Delete one locale row of a collection. The other locale (and its tracks) is preserved."),
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

func registerCollectionTracksSet(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.tracks.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Replace the full ordered membership of (collection id, language) atomically. Each candidate track must have a track_variants row in that language; otherwise the whole call is rejected."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithArray("track_ids", mcp.Required(), mcp.Description("Ordered list of track ids (position 0 first).")),
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
		tracks, err := requireStringList(req, "track_ids")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.SetTracks(ctx, id, lang, tracks); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{
			"id":       id,
			"language": lang,
			"count":    len(tracks),
		}), nil
	})
}

func registerCollectionTracksAdd(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.tracks.add"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Add one track to a collection locale at `position` (default: append). Idempotent — duplicate track id is a no-op."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithNumber("position", mcp.Description("0-based insertion index (default: append).")),
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
		trackID, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		args := req.GetArguments()
		var pos *int
		if v, ok := args["position"].(float64); ok {
			n := int(v)
			pos = &n
		}
		if err := deps.UseCase.AddTrack(ctx, id, lang, trackID, pos); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func registerCollectionTracksRemove(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.tracks.remove"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Remove one track from a collection locale. Idempotent — missing track is a no-op."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("track_id", mcp.Required()),
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
		trackID, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.RemoveTrack(ctx, id, lang, trackID); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

// collectionToWire flattens the per-locale maps into a JSON object suitable for
// the MCP response. Keys are the language codes; consumers iterate them.
func collectionToWire(p catalog.Collection) map[string]any {
	return map[string]any{
		"id":         p.Id,
		"names":      p.Names,
		"featured":   p.Featured,
		"sort_order": p.SortOrder,
	}
}

func requireStringList(req mcp.CallToolRequest, key string) ([]string, error) {
	args := req.GetArguments()
	raw, ok := args[key]
	if !ok {
		return nil, fmt.Errorf("missing required array %q", key)
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("%q must be an array", key)
	}
	out := make([]string, 0, len(arr))
	for i, v := range arr {
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%q[%d] must be a string", key, i)
		}
		out = append(out, s)
	}
	return out, nil
}
