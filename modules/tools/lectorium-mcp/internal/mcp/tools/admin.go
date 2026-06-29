package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	adminapp "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/adminconfig"
	admindomain "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/adminconfig"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// RegisterAdminConfigGet registers admin_config_get. Thin dispatcher:
// args → service.Snapshot → envelope. The interesting code lives in
// internal/application/adminconfig + internal/infra/adminconfig/runtime.
func RegisterAdminConfigGet(s *server.MCPServer, deps Deps) {
	const kind = "admin.config.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Read the effective runtime configuration. With no `path` argument, returns the full sanitized config (secrets redacted). With `path`, returns just that leaf walked by dotted JSON keys."),
		mcp.WithString("path", mcp.Description("Optional dotted path, e.g. `transcribe.default` or `transcribe.providers.transcriber-service.endpoint`. Empty = full tree.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		path := strings.TrimSpace(req.GetString("path", ""))
		tree, err := deps.AdminConfig.Snapshot(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if path == "" {
			return envelope.Result(kind, tree), nil
		}
		leaf, ok := walk(tree, path)
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("path %q not found", path), nil), nil
		}
		return envelope.Result(kind, map[string]any{"path": path, "value": leaf}), nil
	})
}

// RegisterAdminConfigSet registers admin_config_set. Tool description text
// is built from domain.PatternsForDescription() so it can't drift from the
// declarative whitelist.
func RegisterAdminConfigSet(s *server.MCPServer, deps Deps) {
	const kind = "admin.config.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(buildSetDescription()),
		mcp.WithString("path", mcp.Required(), mcp.Description("Dotted target. Must be in the allowlist above.")),
		mcp.WithString("value", mcp.Required(), mcp.Description("New value. Validated per-path (URL syntax, registered name, etc).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		value, err := req.RequireString("value")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		path = strings.TrimSpace(path)
		if path == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "path cannot be empty", nil), nil
		}
		res, err := deps.AdminConfig.Apply(ctx, path, value)
		if err != nil {
			var notSettable *adminapp.ErrNotSettable
			var validation *adminapp.ErrValidation
			switch {
			case errors.As(err, &notSettable):
				return envelope.Err(kind, envelope.CodeInvalidArgument,
					notSettable.Error(),
					map[string]any{"allowed": notSettable.Allowed}), nil
			case errors.As(err, &validation):
				return envelope.Err(kind, envelope.CodeInvalidArgument, validation.Error(), nil), nil
			}
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

// buildSetDescription generates the tool description text from the
// declarative WritablePaths() list. Keeping docs in sync with code.
func buildSetDescription() string {
	var b strings.Builder
	b.WriteString("Mutate one runtime-configurable value. The path must be in the closed allowlist:\n\n")
	for _, p := range admindomain.PatternsForDescription() {
		b.WriteString("  ")
		b.WriteString(p)
		b.WriteString("\n")
	}
	b.WriteString("\nAnything outside this list errors with the full allowlist for self-correction.")
	return b.String()
}

// walk navigates a dotted path through a JSON-shaped tree. Returns the
// leaf value or (nil, false) when any segment is missing.
func walk(tree map[string]any, path string) (any, bool) {
	parts := strings.Split(path, ".")
	var cur any = tree
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		v, ok := m[p]
		if !ok {
			return nil, false
		}
		cur = v
	}
	return cur, true
}
