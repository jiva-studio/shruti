package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// TopicsWriter is the slice of the catalog the topic tools mutate: a full
// replace of one track's language-agnostic topic membership.
type TopicsWriter interface {
	SetTrackTopics(ctx context.Context, trackID string, weights map[string]float64) error
}

// TopicsDeps wires the `track.topics.*` tools to the catalog. The topic
// vocabulary itself is created via the generic `topic.create` dict tool; this
// just assigns existing topics to a track with weights.
type TopicsDeps struct {
	Catalog TopicsWriter
}

// RegisterTopics registers the track↔topic membership tools.
func RegisterTopics(s *server.MCPServer, deps TopicsDeps) {
	registerTrackTopicsSet(s, deps)
}

func registerTrackTopicsSet(s *server.MCPServer, deps TopicsDeps) {
	const kind = "track.topics.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Replace a track's full topic set (language-agnostic). Each entry is "+
			"{topic_id, weight}; the map fully replaces any previous assignment. topic_id should "+
			"reference an existing `topics` dict entry (mint via topic.create). Floor/cap/top-K is "+
			"the caller's concern."),
		mcp.WithString("track_id", mcp.Required()),
		mcp.WithArray("topics", mcp.Required(),
			mcp.Description("Array of {\"topic_id\": \"topic_...\", \"weight\": 0.0-1.0}.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		trackID, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		weights, err := parseTopicWeights(req)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.Catalog.SetTrackTopics(ctx, trackID, weights); err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"track_id": trackID, "count": len(weights)}), nil
	})
}

// parseTopicWeights reads the `topics` array of {topic_id, weight} objects into
// a topic_id→weight map. A duplicate topic_id keeps the last weight.
func parseTopicWeights(req mcp.CallToolRequest) (map[string]float64, error) {
	raw, ok := req.GetArguments()["topics"].([]any)
	if !ok {
		return nil, fmt.Errorf("topics: expected an array of {topic_id, weight}")
	}
	out := make(map[string]float64, len(raw))
	for i, item := range raw {
		obj, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("topics[%d]: expected an object", i)
		}
		id, ok := obj["topic_id"].(string)
		if !ok || id == "" {
			return nil, fmt.Errorf("topics[%d]: missing topic_id", i)
		}
		w, ok := obj["weight"].(float64)
		if !ok {
			return nil, fmt.Errorf("topics[%d] (%s): missing numeric weight", i, id)
		}
		out[id] = w
	}
	return out, nil
}
