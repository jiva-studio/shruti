package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// WisdomStore is the slice of the catalog the `wisdom.*` tools use: write the
// daily_wisdom corpus plus the reads needed to validate referential integrity.
type WisdomStore interface {
	CreateDailyWisdom(ctx context.Context, w catalog.DailyWisdom) error
	ListDailyWisdom(ctx context.Context, topicID, language string, limit int) ([]catalog.DailyWisdom, error)
	DeleteDailyWisdom(ctx context.Context, id string) error
	GetTrack(ctx context.Context, id string) (catalog.TrackRow, bool, error)
	GetDict(ctx context.Context, kind catalog.Kind, id string) (catalog.DictEntry, bool, error)
}

// WisdomDeps wires the daily-wisdom authoring tools.
type WisdomDeps struct {
	Catalog WisdomStore
	Minter  interface{ MintTail() string }
}

// RegisterWisdom registers wisdom.create / wisdom.import / wisdom.list / wisdom.delete.
func RegisterWisdom(s *server.MCPServer, deps WisdomDeps) {
	registerWisdomCreate(s, deps)
	registerWisdomImport(s, deps)
	registerWisdomList(s, deps)
	registerWisdomDelete(s, deps)
}

// validateWisdom checks one fragment's fields and referential integrity. It
// returns a populated row (id minted when blank) ready to insert.
func validateWisdom(ctx context.Context, deps WisdomDeps, w catalog.DailyWisdom) (catalog.DailyWisdom, error) {
	w.TrackID = strings.TrimSpace(w.TrackID)
	w.TopicID = strings.TrimSpace(w.TopicID)
	w.Language = strings.TrimSpace(w.Language)
	w.Text = strings.TrimSpace(w.Text)
	if w.TrackID == "" {
		return w, fmt.Errorf("track_id is required")
	}
	if w.Language == "" {
		return w, fmt.Errorf("language is required")
	}
	if w.Text == "" {
		return w, fmt.Errorf("text is required")
	}
	if w.StartMs < 0 || w.EndMs <= w.StartMs {
		return w, fmt.Errorf("need 0 <= start_ms < end_ms (got %d..%d)", w.StartMs, w.EndMs)
	}
	if _, ok, err := deps.Catalog.GetTrack(ctx, w.TrackID); err != nil {
		return w, fmt.Errorf("checking track %q: %w", w.TrackID, err)
	} else if !ok {
		return w, fmt.Errorf("unknown track_id %q", w.TrackID)
	}
	if _, ok, err := deps.Catalog.GetDict(ctx, catalog.KindTopic, w.TopicID); err != nil {
		return w, fmt.Errorf("checking topic %q: %w", w.TopicID, err)
	} else if !ok {
		return w, fmt.Errorf("unknown topic_id %q", w.TopicID)
	}
	if w.ID == "" {
		w.ID = "wisdom_" + deps.Minter.MintTail()
	}
	return w, nil
}

func registerWisdomCreate(s *server.MCPServer, deps WisdomDeps) {
	const kind = "wisdom.create"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Add one daily-wisdom fragment: a playable lecture excerpt tied to a topic. "+
			"Validated against the catalog (track + topic must exist, 0 <= start_ms < end_ms). "+
			"Mutates current.db — run catalog.publish to ship."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithString("language", mcp.Required(), mcp.Description("Content language of the excerpt, e.g. \"en\".")),
		mcp.WithNumber("start_ms", mcp.Required()),
		mcp.WithNumber("end_ms", mcp.Required()),
		mcp.WithString("text", mcp.Required(), mcp.Description("The aphorism / excerpt text shown in chat.")),
		mcp.WithString("topic_id", mcp.Required(), mcp.Description("Topic this wisdom belongs to.")),
		mcp.WithString("id", mcp.Description("Optional explicit id; minted as wisdom_<tail> when omitted.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		w := catalog.DailyWisdom{
			ID:       strings.TrimSpace(req.GetString("id", "")),
			TrackID:  req.GetString("track_id", ""),
			Language: req.GetString("language", ""),
			StartMs:  int64(req.GetFloat("start_ms", 0)),
			EndMs:    int64(req.GetFloat("end_ms", 0)),
			Text:     req.GetString("text", ""),
			TopicID:  req.GetString("topic_id", ""),
		}
		w, err := validateWisdom(ctx, deps, w)
		if err != nil {
			return envelope.Err(kind, envelope.CodeValidationFailed, err.Error(), nil), nil
		}
		if err := deps.Catalog.CreateDailyWisdom(ctx, w); err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"id": w.ID}), nil
	})
}

func registerWisdomImport(s *server.MCPServer, deps WisdomDeps) {
	const kind = "wisdom.import"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Bulk-add daily-wisdom fragments. Each item is validated; the whole batch "+
			"is rejected if any item is invalid. Mutates current.db — run catalog.publish to ship."),
		mcp.WithArray("items", mcp.Required(),
			mcp.Description("Array of {track_id, language, start_ms, end_ms, text, topic_id, id?}.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, ok := req.GetArguments()["items"].([]any)
		if !ok {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "items: expected an array", nil), nil
		}
		rows := make([]catalog.DailyWisdom, len(raw))
		for i, item := range raw {
			obj, ok := item.(map[string]any)
			if !ok {
				return envelope.Err(kind, envelope.CodeInvalidArgument, fmt.Sprintf("items[%d]: expected an object", i), nil), nil
			}
			w := catalog.DailyWisdom{
				ID:       asString(obj["id"]),
				TrackID:  asString(obj["track_id"]),
				Language: asString(obj["language"]),
				StartMs:  asInt64(obj["start_ms"]),
				EndMs:    asInt64(obj["end_ms"]),
				Text:     asString(obj["text"]),
				TopicID:  asString(obj["topic_id"]),
			}
			validated, err := validateWisdom(ctx, deps, w)
			if err != nil {
				return envelope.Err(kind, envelope.CodeValidationFailed, fmt.Sprintf("items[%d]: %s", i, err.Error()), nil), nil
			}
			rows[i] = validated
		}
		ids := make([]string, 0, len(rows))
		for _, w := range rows {
			if err := deps.Catalog.CreateDailyWisdom(ctx, w); err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			ids = append(ids, w.ID)
		}
		return envelope.Result(kind, map[string]any{"created": len(ids), "ids": ids}), nil
	})
}

func registerWisdomList(s *server.MCPServer, deps WisdomDeps) {
	const kind = "wisdom.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List daily-wisdom fragments, optionally filtered by topic_id and/or language."),
		mcp.WithString("topic_id", mcp.Description("Filter to one topic.")),
		mcp.WithString("language", mcp.Description("Filter to one language.")),
		mcp.WithNumber("limit", mcp.Description("Max rows (default 100).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		limit := int(req.GetFloat("limit", 100))
		items, err := deps.Catalog.ListDailyWisdom(ctx,
			strings.TrimSpace(req.GetString("topic_id", "")),
			strings.TrimSpace(req.GetString("language", "")), limit)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"items": items, "count": len(items)}), nil
	})
}

func registerWisdomDelete(s *server.MCPServer, deps WisdomDeps) {
	const kind = "wisdom.delete"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Delete one daily-wisdom fragment by id. Mutates current.db — run catalog.publish to ship."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.Catalog.DeleteDailyWisdom(ctx, strings.TrimSpace(id)); err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"id": id, "ok": true}), nil
	})
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}
