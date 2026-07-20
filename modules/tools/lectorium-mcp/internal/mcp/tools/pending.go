package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	pendingrefresh "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/pending/refresh"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/promote"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pending"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
	pendingport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/pending"
)

// PendingDeps wires the corpus-promotion queue (issue #1232/#1233): the
// self-fetch of the pending.db artifact, its read side, and the approve gate.
type PendingDeps struct {
	Refresh pendingrefresh.UseCase
	Reader  pendingport.Reader
	Approve promote.UseCase
}

func RegisterPending(s *server.MCPServer, deps PendingDeps) {
	registerPendingRefresh(s, deps)
	registerPendingList(s, deps)
	registerPendingGet(s, deps)
	registerLibraryApprove(s, deps)
}

func registerPendingRefresh(s *server.MCPServer, deps PendingDeps) {
	const kind = "library.pending.refresh"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Self-fetch the user-generated-tracks review artifact (pending.db) from "+
				"the CDN — download → verify → atomic swap, exactly like catalog.refresh. "+
				"The offline admin MCP has no prod-DB access, so the user-generated "+
				"tracks it reviews arrive as a published SQLite artifact (users never "+
				"submit anything — the admin browses and approves)."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		res, err := deps.Refresh.Run(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeDependencyFailed, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func registerPendingList(s *server.MCPServer, deps PendingDeps) {
	const kind = "library.pending.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List user-generated tracks from the fetched pending.db (paginated). Unconsumed only unless include_consumed=true."),
		mcp.WithBoolean("include_consumed", mcp.Description("Also list rows already promoted (consumed). Default false.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 100).")),
		mcp.WithString("cursor", mcp.Description("Cursor (last-seen track_id) from previous page.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		opts := pending.ListOpts{
			IncludeConsumed: req.GetBool("include_consumed", false),
			Limit:           int(req.GetFloat("limit", 100)),
			Cursor:          req.GetString("cursor", ""),
		}
		items, err := deps.Reader.List(ctx, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		nextCursor := ""
		if opts.Limit > 0 && len(items) == opts.Limit {
			nextCursor = items[len(items)-1].TrackID
		}
		return envelope.Result(kind, struct {
			Items      []pending.Track `json:"items"`
			NextCursor string          `json:"next_cursor,omitempty"`
		}{items, nextCursor}), nil
	})
}

func registerPendingGet(s *server.MCPServer, deps PendingDeps) {
	const kind = "library.pending.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Get one user-generated track (raw metadata + public CDN keys) from the fetched pending.db."),
		mcp.WithString("track_id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		tid, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		t, ok, err := deps.Reader.Get(ctx, tid)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("pending track not found: %s", tid), nil), nil
		}
		return envelope.Result(kind, t), nil
	})
}

func registerLibraryApprove(s *server.MCPServer, deps PendingDeps) {
	const kind = "library.approve"
	tool := mcp.NewTool(kind,
		mcp.WithDescription(
			"Promote a user-generated track into the shared corpus (zero-copy): "+
				"writes the catalog track row (reusing the personal track's already-public "+
				"transcript/audio bytes and its stable track_id) with contributor_user_id "+
				"attribution, then marks the pending row consumed. Metadata is normalized at "+
				"the gate — resolve author/location/source via <dict>.resolve and mint canon "+
				"via author.create / source.create / location.create FIRST, then pass the "+
				"resolved ids here (raw pending names are used only as an exact-match "+
				"fallback). On any unresolved/missing field it writes nothing and returns "+
				"{ok:false, missing, unresolved}. Shipping to everyone is the separate async "+
				"catalog.publish tool."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("Pending track id to promote.")),
		mcp.WithString("author_id", mcp.Description("Resolved author dict id (author_…). Falls back to an exact lookup on the raw name.")),
		mcp.WithString("location_id", mcp.Description("Resolved location dict id (location_…). Optional.")),
		mcp.WithString("language", mcp.Description("Variant language. Default: the pending row's lang.")),
		mcp.WithString("title", mcp.Description("Override the corpus title. Default: the pending row's raw title.")),
		mcp.WithString("date", mcp.Description("Override the date (YYYY-MM-DD). Default: the pending row's raw date.")),
		mcp.WithString("contributor_user_id", mcp.Description("Attribution override. Default: the pending row's owner_id.")),
		mcp.WithArray("references", mcp.Description("Resolved scripture refs: [{source_id, tokens}]. Each source_id must already exist in canon."),
			mcp.Items(map[string]any{
				"type": "object",
				"properties": map[string]any{
					"source_id": map[string]any{"type": "string"},
					"tokens":    map[string]any{"type": "string"},
				},
				"required": []string{"source_id"},
			}),
		),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		tid, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		in := promote.Input{
			TrackID:           tid,
			AuthorID:          req.GetString("author_id", ""),
			LocationID:        req.GetString("location_id", ""),
			Language:          req.GetString("language", ""),
			Title:             req.GetString("title", ""),
			Date:              req.GetString("date", ""),
			ContributorUserID: req.GetString("contributor_user_id", ""),
			References:        parseApproveRefs(req),
		}
		res, err := deps.Approve.Approve(ctx, in)
		if err != nil {
			if err == promote.ErrNotFound {
				return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("pending track not found: %s", tid), nil), nil
			}
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		// A validation refusal is ok:true with result.ok:false (mirrors track.commit).
		return envelope.Result(kind, res), nil
	})
}

// parseApproveRefs pulls the optional references[] argument into typed refs.
// Malformed entries are skipped here; the use case revalidates every source_id
// against the live catalog anyway.
func parseApproveRefs(req mcp.CallToolRequest) []promote.Ref {
	raw, ok := req.GetArguments()["references"]
	if !ok || raw == nil {
		return nil
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]promote.Ref, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		var r promote.Ref
		if v, ok := m["source_id"].(string); ok {
			r.SourceID = v
		}
		if v, ok := m["tokens"].(string); ok {
			r.Tokens = v
		}
		if r.SourceID != "" {
			out = append(out, r)
		}
	}
	return out
}
