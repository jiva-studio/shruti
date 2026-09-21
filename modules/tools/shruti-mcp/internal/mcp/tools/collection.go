package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectioncrud"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/covergen"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// CollectionCRUDDeps wires `collection.*` tools to the collectioncrud use case
// plus the cover generator (for collection.cover.generate and auto-cover on
// create). Cover is zero/disabled when image generation isn't configured.
type CollectionCRUDDeps struct {
	UseCase collectioncrud.UseCase
	Cover   covergen.UseCase
}

// RegisterCollectionCRUD registers all 12 collection tools:
//
//	collection.create / collection.update / collection.get / collection.list /
//	collection.delete / collection.delete_locale /
//	collection.tracks.set / collection.tracks.add / collection.tracks.remove /
//	collection.tags.set / collection.tags.add / collection.tags.remove
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
	registerCollectionTagsSet(s, deps)
	registerCollectionTagsAdd(s, deps)
	registerCollectionTagsRemove(s, deps)
	registerCollectionCoverGenerate(s, deps)
}

func registerCollectionCreate(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.create"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(`Create a collection locale row. id is optional: omit to mint a new pack_<12 alnum>; supply an existing id to add a second locale to an existing collection. To feature it on the mobile home, add the tag_featured tag via collection.tags.add.`),
		mcp.WithString("id", mcp.Description("Existing collection id (for second-locale create). Empty/omitted = mint new.")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Locale code (e.g. ru / en).")),
		mcp.WithString("name", mcp.Required(), mcp.Description("Human-readable collection name in this locale.")),
		mcp.WithString("cover", mcp.Description("S3 asset key for the cover, e.g. public/collections/<id>/cover.jpg.")),
		mcp.WithString("description", mcp.Description("Collection description in this locale.")),
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
		in := collectioncrud.CreateInput{
			ID:          req.GetString("id", ""),
			Language:    lang,
			Name:        name,
			Cover:       req.GetString("cover", ""),
			Description: req.GetString("description", ""),
			Meta:        req.GetString("meta", ""),
			SortOrder:   int(req.GetFloat("sort_order", 0)),
		}
		id, err := deps.UseCase.Create(ctx, in)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		result := map[string]any{
			"id":          id,
			"language":    lang,
			"name":        name,
			"cover":       in.Cover,
			"description": in.Description,
			"meta":        in.Meta,
			"sort_order":  in.SortOrder,
		}
		// Auto-generate a cover for a freshly-minted collection (only on the
		// first-locale create, i.e. no caller id). Best-effort: a failure
		// leaves the collection without a cover but does not fail the create.
		if in.ID == "" && in.Cover == "" && deps.Cover.Enabled() {
			if key, gerr := deps.Cover.Generate(ctx, id, lang, ""); gerr != nil {
				result["cover_error"] = gerr.Error()
			} else {
				result["cover"] = key
			}
		}
		return envelope.Result(kind, result), nil
	})
}

func registerCollectionUpdate(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.update"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Patch one (collection.id, language) locale. Only fields you supply are changed. Featured state is a tag — use collection.tags.add/remove."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("name"),
		mcp.WithString("cover"),
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
		in := collectioncrud.UpdateInput{ID: id, Language: lang}
		if v, ok := args["name"].(string); ok {
			in.Name = &v
		}
		if v, ok := args["cover"].(string); ok {
			in.Cover = &v
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
		mcp.WithDescription("List collections filtered by language and/or tag (e.g. tag=tag_featured for the home shelf). Returns collections without their track membership for compact responses."),
		mcp.WithString("language", mcp.Description("Filter to a single locale.")),
		mcp.WithString("tag", mcp.Description("If set, only collections carrying this tag id are returned (e.g. tag_featured).")),
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
		if v, ok := args["tag"].(string); ok && v != "" {
			opts.Tag = &v
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

func registerCollectionTagsSet(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.tags.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Replace the full tag membership of (collection id, language). Use tag_featured to surface the collection on the mobile home shelf."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithArray("tag_ids", mcp.Required(), mcp.Description("Tag ids (e.g. tag_featured).")),
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
		tags, err := requireStringList(req, "tag_ids")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.SetTags(ctx, id, lang, tags); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"id": id, "language": lang, "count": len(tags)}), nil
	})
}

func registerCollectionTagsAdd(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.tags.add"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Add one tag to a collection locale. Idempotent — duplicate tag is a no-op."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("tag_id", mcp.Required(), mcp.Description("Tag id (e.g. tag_featured).")),
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
		tagID, err := req.RequireString("tag_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.AddTag(ctx, id, lang, tagID); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func registerCollectionTagsRemove(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.tags.remove"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Remove one tag from a collection locale. Idempotent — missing tag is a no-op."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("tag_id", mcp.Required()),
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
		tagID, err := req.RequireString("tag_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.RemoveTag(ctx, id, lang, tagID); err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func registerCollectionCoverGenerate(s *server.MCPServer, deps CollectionCRUDDeps) {
	kind := "collection.cover.generate"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Generate (or regenerate) the collection's cover image from its name/description via the configured image model, upload it to S3 (public/collections/<id>/cover.jpg), and set the cover key on every locale. Pass extra_prompt to steer the art, restyle=true to repaint the existing cover instead of drawing a new subject."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Description("Locale whose name/description seed the prompt (en fallback).")),
		mcp.WithString("extra_prompt", mcp.Description("Optional extra prompt fragment appended to steer the generation.")),
		mcp.WithBoolean("restyle", mcp.Description("Feed the current cover to the model and repaint it in the house style, keeping its subject. No-op when there is no cover yet.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !deps.Cover.Enabled() {
			return envelope.Err(kind, envelope.CodeInvalidArgument,
				"image generation is not configured (set images.api_key)", nil), nil
		}
		var opts []covergen.Option
		if req.GetBool("restyle", false) {
			opts = append(opts, covergen.Restyle())
		}
		key, err := deps.Cover.Generate(ctx, id, req.GetString("language", ""), req.GetString("extra_prompt", ""), opts...)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"id": id, "cover": key}), nil
	})
}

// collectionToWire flattens the per-locale maps into a JSON object suitable for
// the MCP response. Keys are the language codes; consumers iterate them.
func collectionToWire(c catalog.Collection) map[string]any {
	return map[string]any{
		"id":           c.ID,
		"names":        c.Names,
		"descriptions": c.Descriptions,
		"covers":       c.Covers,
		"meta":         c.Meta,
		"sort_order":   c.SortOrder,
		"tags":         c.TagIDs,
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
