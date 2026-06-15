package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/runner"
	topicsapp "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/topics"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// TopicsWriter is the slice of the catalog the topic tools mutate: a full
// replace of one track's language-agnostic topic membership.
type TopicsWriter interface {
	SetTrackTopics(ctx context.Context, trackID string, weights map[string]float64) error
}

// TopicsDeps wires the `topics.*` / `track.topics.*` tools. Catalog backs the
// manual track.topics.set; Build/Assign are the offline vocabulary build and
// per-track assignment (disabled when the embeddings client isn't configured).
type TopicsDeps struct {
	Catalog TopicsWriter
	Build   topicsapp.BuildUseCase
	Assign  topicsapp.AssignUseCase
}

// topicsConfigured reports whether the embedding-backed build/assign are wired
// (embeddings client present).
func (d TopicsDeps) topicsConfigured() bool { return d.Assign.Embed != nil }

// RegisterTopics registers the topic vocabulary + membership tools.
func RegisterTopics(s *server.MCPServer, deps Deps) {
	registerTrackTopicsSet(s, deps.Topics)
	registerTopicsBuild(s, deps)
	registerTrackTopicsAssign(s, deps)
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

func registerTopicsBuild(s *server.MCPServer, deps Deps) {
	const kind = "topics.build"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Build the canonical topic vocabulary from ALL granular outline "+
			"artifacts: embed the headings, cluster them into ~K topics, name each cluster (ru/en) "+
			"and mint a topics dict entry, then write the centroids artifact. Does NOT assign tracks "+
			"— run pipeline.run op=topics afterwards. One-time / on re-cluster. Async: returns a "+
			"run_id; poll via runs.status / runs.wait."),
		mcp.WithNumber("k", mcp.Description("Override the number of topic clusters (default from config; lower for small training corpora).")))
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
		if !deps.Topics.topicsConfigured() {
			return envelope.Err(kind, envelope.CodeDependencyFailed, "topics not configured (set config embed.api_key + embed.model + outline.* for naming)", nil), nil
		}
		build := deps.Topics.Build
		if v, ok := req.GetArguments()["k"].(float64); ok && int(v) > 0 {
			build.K = int(v)
		}
		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindTopicsBuild,
			Cancellable: true,
			Init:        run.Run{Progress: run.Progress{FilesTotal: 1}},
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				res, err := build.Run(workCtx)
				if err != nil {
					return nil, err
				}
				report(run.Progress{FilesTotal: 1, FilesDone: 1})
				return json.Marshal(res)
			},
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
		}
		return envelope.Run(kind, runDispatch{
			Id: runId, Kind: string(run.KindTopicsBuild), State: string(run.StateQueued), AcceptedCount: 1,
		}), nil
	})
}

func registerTrackTopicsAssign(s *server.MCPServer, deps Deps) {
	const kind = "track.topics.assign"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Assign weighted topics to ONE track by matching its granular outline "+
			"headings to the canonical topic centroids (built by topics.build). Reads every "+
			"language's granular outline, merges, and replaces the track's track_topics. Async: "+
			"returns a run_id. For BATCH use pipeline.run op=topics selector=…."),
		mcp.WithString("track_id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if deps.Runner == nil {
			return envelope.Err(kind, envelope.CodeInternal, "runner not initialized", nil), nil
		}
		if !deps.Topics.topicsConfigured() {
			return envelope.Err(kind, envelope.CodeDependencyFailed, "topics not configured (set config embed.api_key + embed.model)", nil), nil
		}
		tid, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		id, err := track.NewId(tid)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		runId, err := deps.Runner.Submit(ctx, runner.Spec{
			Kind:        run.KindTopicsAssign,
			Cancellable: true,
			Init:        run.Run{Targets: []string{string(id)}, Progress: run.Progress{FilesTotal: 1}},
			WorkFn: func(workCtx context.Context, report runner.ProgressFn) (json.RawMessage, error) {
				res, err := deps.Topics.Assign.Run(workCtx, id)
				if err != nil {
					return nil, err
				}
				report(run.Progress{FilesTotal: 1, FilesDone: 1})
				return json.Marshal(res)
			},
		})
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, "submit run: "+err.Error(), nil), nil
		}
		return envelope.Run(kind, runDispatch{
			Id: runId, Kind: string(run.KindTopicsAssign), State: string(run.StateQueued), AcceptedCount: 1,
		}), nil
	})
}
