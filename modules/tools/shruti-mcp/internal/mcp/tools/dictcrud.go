package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/catalog/dictcrud"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

type DictCRUDDeps struct {
	UseCase dictcrud.UseCase
}

func RegisterDictCRUD(s *server.MCPServer, deps DictCRUDDeps) {
	for _, k := range []struct {
		kind   catalog.Kind
		prefix string
	}{
		{catalog.KindAuthor, "author"},
		{catalog.KindLocation, "location"},
		{catalog.KindSource, "source"},
		{catalog.KindTag, "tag"},
		{catalog.KindTopic, "topic"},
	} {
		registerCreate(s, deps, k.kind, k.prefix)
		registerUpdate(s, deps, k.kind, k.prefix)
		registerDeleteLocale(s, deps, k.kind, k.prefix)
		registerDelete(s, deps, k.kind, k.prefix)
	}
}

func registerCreate(s *server.MCPServer, deps DictCRUDDeps, dictKind catalog.Kind, prefix string) {
	kind := prefix + ".create"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(fmt.Sprintf("Mint a new %s id and insert one row per locale.", dictKind)),
		mcp.WithObject("names", mcp.Required(), mcp.Description("language→full_name (e.g. {\"ru\":\"...\",\"en\":\"...\"}).")),
		mcp.WithObject("short_name", mcp.Description("language→short_name (sources only).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		names, err := requireStringMap(req, "names")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		short, _ := optionalStringMap(req, "short_name")
		id, err := deps.UseCase.Create(ctx, dictKind, names, short)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]string{"id": id}), nil
	})
}

func registerUpdate(s *server.MCPServer, deps DictCRUDDeps, dictKind catalog.Kind, prefix string) {
	kind := prefix + ".update"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(fmt.Sprintf("UPSERT one (%s.id, language) locale.", dictKind)),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("full_name", mcp.Required()),
		mcp.WithString("short_name", mcp.Description("Only for sources.")),
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
		fullName, err := req.RequireString("full_name")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		short := req.GetString("short_name", "")
		if err := deps.UseCase.Update(ctx, dictKind, id, lang, fullName, short); err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func registerDeleteLocale(s *server.MCPServer, deps DictCRUDDeps, dictKind catalog.Kind, prefix string) {
	kind := prefix + ".delete_locale"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(fmt.Sprintf("Delete one locale row of a %s. Refuses to delete the last locale if usage_count > 0.", dictKind)),
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
		if err := deps.UseCase.DeleteLocale(ctx, dictKind, id, lang); err != nil {
			return envelope.Err(kind, envelope.CodeConflict, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func registerDelete(s *server.MCPServer, deps DictCRUDDeps, dictKind catalog.Kind, prefix string) {
	kind := prefix + ".delete"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(fmt.Sprintf("Delete all locales of a %s. Refuses if usage_count > 0.", dictKind)),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.Delete(ctx, dictKind, id); err != nil {
			return envelope.Err(kind, envelope.CodeConflict, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]bool{"ok": true}), nil
	})
}

func requireStringMap(req mcp.CallToolRequest, key string) (map[string]string, error) {
	args := req.GetArguments()
	raw, ok := args[key]
	if !ok {
		return nil, fmt.Errorf("missing required object %q", key)
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%q must be an object", key)
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%q.%s must be a string", key, k)
		}
		out[k] = s
	}
	return out, nil
}

func optionalStringMap(req mcp.CallToolRequest, key string) (map[string]string, error) {
	args := req.GetArguments()
	raw, ok := args[key]
	if !ok || raw == nil {
		return nil, nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%q must be an object", key)
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out, nil
}
