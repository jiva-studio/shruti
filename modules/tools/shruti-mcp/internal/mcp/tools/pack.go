package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/packcrud"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// PackCRUDDeps wires `pack.*` tools to the packcrud use case.
type PackCRUDDeps struct {
	UseCase packcrud.UseCase
}

// RegisterPackCRUD registers all 9 starter-pack tools:
//
//	pack.create / pack.update / pack.get / pack.list /
//	pack.delete / pack.delete_locale /
//	pack.tracks.set / pack.tracks.add / pack.tracks.remove
//
// All sync; envelope shape `{ok, kind, result}`.
func RegisterPackCRUD(s *server.MCPServer, deps PackCRUDDeps) {
	registerPackCreate(s, deps)
	registerPackUpdate(s, deps)
	registerPackGet(s, deps)
	registerPackList(s, deps)
	registerPackDelete(s, deps)
	registerPackDeleteLocale(s, deps)
	registerPackTracksSet(s, deps)
	registerPackTracksAdd(s, deps)
	registerPackTracksRemove(s, deps)
}

func registerPackCreate(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.create"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(`Create a starter-pack locale row. id is optional: omit to mint a new pack_<12 alnum>; supply an existing id to add a second locale to an existing pack.`),
		mcp.WithString("id", mcp.Description("Existing pack id (for second-locale create). Empty/omitted = mint new.")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Locale code (e.g. ru / en).")),
		mcp.WithString("name", mcp.Required(), mcp.Description("Human-readable pack name in this locale.")),
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
		in := packcrud.CreateInput{
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

func registerPackUpdate(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.update"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Patch one (pack.id, language) locale. Only fields you supply are changed."),
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
		in := packcrud.UpdateInput{ID: id, Language: lang}
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

func registerPackGet(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Get the pack collapsed across locales plus its track membership per locale."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		pack, tracks, ok, err := deps.UseCase.Get(ctx, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("pack/%s not found", id), nil), nil
		}
		return envelope.Result(kind, map[string]any{
			"pack":   packToWire(pack),
			"tracks": tracks,
		}), nil
	})
}

func registerPackList(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List packs filtered by language / featured. Returns packs without their track membership for compact responses."),
		mcp.WithString("language", mcp.Description("Filter to a single locale.")),
		mcp.WithBoolean("featured", mcp.Description("If set, only featured=true (or =false) rows are returned.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 100).")),
		mcp.WithString("cursor", mcp.Description("Opaque id cursor for pagination.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		opts := catalog.PackListOpts{
			Limit:  int(req.GetFloat("limit", 0)),
			Cursor: req.GetString("cursor", ""),
		}
		if v, ok := args["language"].(string); ok && v != "" {
			opts.Language = &v
		}
		if v, ok := args["featured"].(bool); ok {
			opts.Featured = &v
		}
		packs, err := deps.UseCase.List(ctx, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		out := make([]map[string]any, 0, len(packs))
		for _, p := range packs {
			out = append(out, packToWire(p))
		}
		return envelope.Result(kind, map[string]any{"packs": out}), nil
	})
}

func registerPackDelete(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.delete"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Delete all locales of a pack (cascades pack_tracks)."),
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

func registerPackDeleteLocale(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.delete_locale"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Delete one locale row of a pack. The other locale (and its tracks) is preserved."),
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

func registerPackTracksSet(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.tracks.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Replace the full ordered membership of (pack id, language) atomically. Each candidate track must have a track_variants row in that language; otherwise the whole call is rejected."),
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

func registerPackTracksAdd(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.tracks.add"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Add one track to a pack locale at `position` (default: append). Idempotent — duplicate track id is a no-op."),
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

func registerPackTracksRemove(s *server.MCPServer, deps PackCRUDDeps) {
	kind := "pack.tracks.remove"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Remove one track from a pack locale. Idempotent — missing track is a no-op."),
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

// packToWire flattens the per-locale maps into a JSON object suitable for
// the MCP response. Keys are the language codes; consumers iterate them.
func packToWire(p catalog.Pack) map[string]any {
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
