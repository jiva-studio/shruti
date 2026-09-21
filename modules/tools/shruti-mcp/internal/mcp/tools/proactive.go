package tools

import (
	"context"
	"errors"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/proactive"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// ProactiveDeps bundles the proactive use-case for tool wiring. Lives in
// the composition root via main.go and is passed to RegisterCatalogProactive
// from tools.RegisterAll.
type ProactiveDeps struct {
	UseCase proactive.UseCase
}

func RegisterCatalogProactive(s *server.MCPServer, deps ProactiveDeps) {
	registerProactiveGet(s, deps)
	registerProactiveMasterSet(s, deps)
	registerProactiveHolidayAdd(s, deps)
	registerProactiveHolidayRemove(s, deps)
	registerProactiveHolidayList(s, deps)
	registerProactiveRuleSet(s, deps)
	registerProactiveRuleRemove(s, deps)
	registerProactiveRuleList(s, deps)
}

func registerProactiveGet(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Read the on-disk proactive.json (rules + holiday calendar + master switch). Returns {empty: true} when the file is absent."),
	)
	s.AddTool(tool, func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		got, err := deps.UseCase.Get()
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, got), nil
	})
}

func registerProactiveMasterSet(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.master_set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Flip the top-level proactive.master_enabled kill switch. Creates proactive.json if absent."),
		mcp.WithBoolean("enabled", mcp.Required(), mcp.Description("true = enable proactive subsystem; false = global off")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		enabled, ok := args["enabled"].(bool)
		if !ok {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "enabled is required (bool)", nil), nil
		}
		res, err := deps.UseCase.MasterSet(enabled)
		if err != nil {
			return envelopeFromError(kind, err), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerProactiveHolidayAdd(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.holiday_add"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Upsert one holiday in proactive.json calendars.holidays[] by id."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Slug-style holiday id, [a-z0-9_]{1,64}. Example: \"janmashtami_2026\".")),
		mcp.WithObject("name", mcp.Required(), mcp.Description("Localised display names — {en?: str, ru?: str}. At least one locale required.")),
		mcp.WithString("date", mcp.Required(), mcp.Description("Local date, YYYY-MM-DD.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		date, err := req.RequireString("date")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		name, err := requireStringMap(req, "name")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		res, err := deps.UseCase.HolidayAdd(proactive.HolidayInput{
			ID: id, Name: name, Date: date,
		})
		if err != nil {
			return envelopeFromError(kind, err), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerProactiveHolidayRemove(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.holiday_remove"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Remove one holiday by id. Returns not_found if it isn't there."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		res, err := deps.UseCase.HolidayRemove(id)
		if err != nil {
			return envelopeFromError(kind, err), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerProactiveHolidayList(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.holiday_list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List all holidays from proactive.json, sorted by date (ascending)."),
	)
	s.AddTool(tool, func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		out, err := deps.UseCase.HolidayList()
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"holidays": out}), nil
	})
}

func registerProactiveRuleSet(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.rule_set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Upsert a per-rule override in proactive.json rules[]. NOTE: the mobile side REPLACES the bundled default with this entry (registry.ts:117), so callers must pass the full object — partial patches drop the omitted fields."),
		mcp.WithString("id", mcp.Required(), mcp.Description("One of holiday | weekly_digest | inactivity | enable_notifications_hint | smart_library_hint | next_shloka.")),
		mcp.WithBoolean("enabled", mcp.Required()),
		mcp.WithString("mode", mcp.Required(), mcp.Description("pre_baked | lazy")),
		mcp.WithNumber("prep_window_hours", mcp.Required()),
		mcp.WithNumber("refresh_if_older_than_hours", mcp.Required()),
		mcp.WithString("session_strategy", mcp.Required(), mcp.Description("new_session | append_current | system_session")),
		mcp.WithNumber("cooldown_hours", mcp.Required()),
		mcp.WithString("session_title_template", mcp.Description("Optional mustache-style template, e.g. \"{holiday_name}\".")),
		mcp.WithNumber("dismiss_resets_after_hours", mcp.Description("Optional. If set, dismissed instances re-fire after this many hours.")),
		mcp.WithArray("eligibility", mcp.Description("Optional [{predicate, value}]. Predicate is one of current_streak_at_least | completed_tracks_at_least | total_listened_seconds_at_least | days_since_install_at_least | has_notifications_permission | is_subscribed; value is number or bool depending on predicate.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := req.GetArguments()
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		mode, err := req.RequireString("mode")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		strategy, err := req.RequireString("session_strategy")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		enabled, ok := args["enabled"].(bool)
		if !ok {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "enabled is required (bool)", nil), nil
		}
		prep, err := requireInt(args, "prep_window_hours")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		refresh, err := requireInt(args, "refresh_if_older_than_hours")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		cooldown, err := requireInt(args, "cooldown_hours")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		input := proactive.RuleInput{
			ID:                      id,
			Enabled:                 enabled,
			Mode:                    mode,
			PrepWindowHours:         prep,
			RefreshIfOlderThanHours: refresh,
			SessionStrategy:         strategy,
			CooldownHours:           cooldown,
		}
		if v, ok := args["session_title_template"].(string); ok && v != "" {
			input.SessionTitleTemplate = v
		}
		if v, ok := args["dismiss_resets_after_hours"].(float64); ok {
			vi := int(v)
			input.DismissResetsAfterHours = &vi
		}
		if rawArr, ok := args["eligibility"].([]any); ok {
			elig := make([]proactive.EligibilityInput, 0, len(rawArr))
			for i, item := range rawArr {
				m, ok := item.(map[string]any)
				if !ok {
					return envelope.Err(kind, envelope.CodeInvalidArgument, fmt.Sprintf("eligibility[%d] must be {predicate, value}", i), nil), nil
				}
				pred, _ := m["predicate"].(string)
				if pred == "" {
					return envelope.Err(kind, envelope.CodeInvalidArgument, fmt.Sprintf("eligibility[%d].predicate is required", i), nil), nil
				}
				elig = append(elig, proactive.EligibilityInput{Predicate: pred, Value: m["value"]})
			}
			input.Eligibility = elig
		}
		res, err := deps.UseCase.RuleSet(input)
		if err != nil {
			return envelopeFromError(kind, err), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerProactiveRuleRemove(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.rule_remove"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Drop a per-rule override so the mobile client falls back to its bundled default."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		res, err := deps.UseCase.RuleRemove(id)
		if err != nil {
			return envelopeFromError(kind, err), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerProactiveRuleList(s *server.MCPServer, deps ProactiveDeps) {
	const kind = "catalog.proactive.rule_list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List all currently-overridden rules in proactive.json."),
	)
	s.AddTool(tool, func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		out, err := deps.UseCase.RuleList()
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"rules": out}), nil
	})
}

// envelopeFromError maps domain errors to the right envelope code so the
// MCP layer's `error.code` is informative without callers needing to
// parse error.message.
func envelopeFromError(kind string, err error) *mcp.CallToolResult {
	var ve *proactive.ValidationError
	if errors.As(err, &ve) {
		return envelope.Err(kind, envelope.CodeValidationFailed, ve.Error(), map[string]any{"field": ve.Field})
	}
	var nfe *proactive.NotFoundError
	if errors.As(err, &nfe) {
		return envelope.Err(kind, envelope.CodeNotFound, nfe.Error(), map[string]any{
			"entity": nfe.Entity,
			"id":     nfe.Key,
		})
	}
	return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil)
}

// requireInt extracts an integer arg from the parsed JSON map. MCP gives
// us JSON numbers as float64; we narrow to int and error if the field is
// missing or non-numeric.
func requireInt(args map[string]any, key string) (int, error) {
	raw, ok := args[key]
	if !ok {
		return 0, fmt.Errorf("%q is required", key)
	}
	switch v := raw.(type) {
	case float64:
		return int(v), nil
	case int:
		return v, nil
	case int64:
		return int(v), nil
	}
	return 0, fmt.Errorf("%q must be a number", key)
}
