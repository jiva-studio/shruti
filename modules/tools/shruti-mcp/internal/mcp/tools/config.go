package tools

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	configregistry "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/config/registry"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// SettingsStore is the slice of the catalog the `config.*` tools read/write:
// the general-purpose settings store.
type SettingsStore interface {
	GetSetting(ctx context.Context, key string) (string, bool, error)
	SetSetting(ctx context.Context, key, value string) error
	ListSettings(ctx context.Context, prefix string) ([]catalog.Setting, error)
}

// ConfigDeps wires the `config.*` tools: the settings store (where values live) and
// the registry (which keys exist, their schema, and how to validate them).
type ConfigDeps struct {
	Settings SettingsStore
	Registry *configregistry.Registry
}

// RegisterConfig registers config.describe / config.get / config.set.
func RegisterConfig(s *server.MCPServer, deps ConfigDeps) {
	registerConfigDescribe(s, deps)
	registerConfigGet(s, deps)
	registerConfigSet(s, deps)
}

type configDescriptorView struct {
	Key         string          `json:"key"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
}

func registerConfigDescribe(s *server.MCPServer, deps ConfigDeps) {
	const kind = "config.describe"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List every known config key with its description and JSON Schema. "+
			"Use this to discover what configs exist and the exact value shape each expects "+
			"before calling config.set. Values are stored in the catalog DB; ship with catalog.publish."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		descs := deps.Registry.Describe()
		out := make([]configDescriptorView, 0, len(descs))
		for _, d := range descs {
			out = append(out, configDescriptorView{Key: d.Key, Description: d.Description, Schema: d.Schema})
		}
		return envelope.Result(kind, map[string]any{"configs": out}), nil
	})
}

func registerConfigGet(s *server.MCPServer, deps ConfigDeps) {
	const kind = "config.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Read the current stored value of a config key from the catalog DB. "+
			"Returns exists:false when the key has never been set."),
		mcp.WithString("key", mcp.Required(), mcp.Description("Config key, e.g. \"onboarding.topics\".")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		key, err := req.RequireString("key")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		key = strings.TrimSpace(key)
		value, ok, err := deps.Settings.GetSetting(ctx, key)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		res := map[string]any{"key": key, "exists": ok}
		if ok {
			res["value"] = json.RawMessage(value)
		}
		if d, known := deps.Registry.Get(key); known {
			res["description"] = d.Description
			res["schema"] = d.Schema
		}
		return envelope.Result(kind, res), nil
	})
}

func registerConfigSet(s *server.MCPServer, deps ConfigDeps) {
	const kind = "config.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Set a config key in the catalog DB. The key must be registered "+
			"(see config.describe) and the value is validated against its schema/validator before "+
			"being written. NOTE: this mutates the local current.db — run catalog.publish to ship it "+
			"to clients."),
		mcp.WithString("key", mcp.Required(), mcp.Description("Config key, e.g. \"onboarding.topics\".")),
		mcp.WithString("value", mcp.Required(), mcp.Description("JSON value matching the key's schema.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		key, err := req.RequireString("key")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		value, err := req.RequireString("value")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		key = strings.TrimSpace(key)

		d, known := deps.Registry.Get(key)
		if !known {
			return envelope.Err(kind, envelope.CodeInvalidArgument,
				"unknown config key "+key,
				map[string]any{"known_keys": deps.Registry.Keys()}), nil
		}
		if !json.Valid([]byte(value)) {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "value is not valid JSON", nil), nil
		}
		if err := deps.Registry.Validate(ctx, key, []byte(value)); err != nil {
			return envelope.Err(kind, envelope.CodeValidationFailed, err.Error(), nil), nil
		}
		if err := deps.Settings.SetSetting(ctx, key, value); err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"key": key, "ok": true, "schema": d.Schema}), nil
	})
}
