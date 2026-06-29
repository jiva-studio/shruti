package mcpsrv

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/services/search-mcp/internal/config"
	"github.com/jiva-studio/shruti/modules/services/search-mcp/internal/embed"
	"github.com/jiva-studio/shruti/modules/services/search-mcp/internal/envelope"
	"github.com/jiva-studio/shruti/modules/services/search-mcp/internal/search"
)

const (
	defaultLimit = 10
	maxLimit     = 50
	trgmMinSim   = 0.3
)

// RegisterTools wires search / search_get / search_window onto srv.
func RegisterTools(srv *server.MCPServer, pool *pgxpool.Pool, embedder *embed.Client, cfg config.Config) {
	repo := search.NewRepo(pool, cfg)
	registerSearch(srv, repo, embedder)
	registerSearchGet(srv, repo)
	registerSearchWindow(srv, repo)
}

func registerSearch(srv *server.MCPServer, repo *search.Repo, embedder *embed.Client) {
	const kind = "search"
	t := mcp.NewTool(kind,
		mcp.WithDescription(
			"Semantic + lexical search over the chat corpus (chunks). Returns the "+
				"chunks that back a topic, with the ids needed to attribute them via "+
				"shruti-mcp library.attribution.ref_add:\n"+
				"  - library hit (kind verse/commentary/prose_chapter/letter): use item_id → ref_kind=document (or verse)\n"+
				"  - title hit: use source_id+tokens → ref_kind=title\n"+
				"  - transcript hit (kind track_transcript): use track_id + start_ms/end_ms → ref_kind=track\n"+
				"Use scope to restrict where to look."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Natural-language query.")),
		mcp.WithString("scope", mcp.Description("transcript | library | all (default all).")),
		mcp.WithString("lang", mcp.Description("Restrict to a language (ISO-639-1, e.g. ru/en).")),
		mcp.WithString("mode", mcp.Description("hybrid | vector | lexical (default hybrid).")),
		mcp.WithNumber("limit", mcp.Description("Max results (default 10, max 50).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		query, err := req.RequireString("query")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if strings.TrimSpace(query) == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "query must not be empty", nil), nil
		}
		scope := req.GetString("scope", "all")
		kinds, err := search.KindsForScope(scope)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang := req.GetString("lang", "")
		mode := req.GetString("mode", "hybrid")
		limit := clampLimit(req.GetInt("limit", defaultLimit))

		var hits []search.Hit
		// Lexical-only never needs an embedding; vector + hybrid do.
		if mode == "lexical" {
			hits, err = repo.Lexical(ctx, query, nil, kinds, lang, limit, trgmMinSim)
		} else {
			vec, eerr := embedder.Query(ctx, query)
			if eerr != nil {
				return envelope.Err(kind, envelope.CodeDependencyFailed, "embed query: "+eerr.Error(), nil), nil
			}
			switch mode {
			case "vector":
				hits, err = repo.Vector(ctx, vec, kinds, lang, limit)
			case "hybrid":
				hits, err = repo.Hybrid(ctx, query, vec, kinds, lang, limit, trgmMinSim)
			default:
				return envelope.Err(kind, envelope.CodeInvalidArgument,
					fmt.Sprintf("invalid mode %q (hybrid|vector|lexical)", mode), nil), nil
			}
		}
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{
			"scope": scope, "mode": mode, "count": len(hits), "hits": hits,
		}), nil
	})
}

func registerSearchGet(srv *server.MCPServer, repo *search.Repo) {
	const kind = "search_get"
	t := mcp.NewTool(kind,
		mcp.WithDescription(
			"Fetch the full text of a source to verify before attributing. Provide "+
				"item_id (all segments of a library document/verse) OR chunk_id (one chunk)."),
		mcp.WithString("item_id", mcp.Description("Library item id (doc_… / verse id). Returns all its chunks.")),
		mcp.WithString("chunk_id", mcp.Description("A single chunk id (from a search hit).")),
		mcp.WithString("lang", mcp.Description("Restrict to a language (only with item_id).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		itemID := req.GetString("item_id", "")
		chunkIDStr := req.GetString("chunk_id", "")
		lang := req.GetString("lang", "")
		if itemID == "" && chunkIDStr == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "provide item_id or chunk_id", nil), nil
		}
		var hits []search.Hit
		var err error
		if chunkIDStr != "" {
			id, perr := strconv.ParseInt(chunkIDStr, 10, 64)
			if perr != nil {
				return envelope.Err(kind, envelope.CodeInvalidArgument, "chunk_id must be an integer", nil), nil
			}
			hits, err = repo.ByChunkID(ctx, id)
		} else {
			hits, err = repo.ByItemID(ctx, itemID, lang)
		}
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if len(hits) == 0 {
			return envelope.Err(kind, envelope.CodeNotFound, "no chunks found", nil), nil
		}
		return envelope.Result(kind, map[string]any{"count": len(hits), "chunks": hits}), nil
	})
}

func registerSearchWindow(srv *server.MCPServer, repo *search.Repo) {
	const kind = "search_window"
	t := mcp.NewTool(kind,
		mcp.WithDescription(
			"Inspect the transcript chunks of a lecture around a time range — the "+
				"same overlap window chat uses to resolve a ref_kind=track fragment. "+
				"Use to read context before attributing track_<id>@<start>-<end>."),
		mcp.WithString("track_id", mcp.Required(), mcp.Description("Lecture track id (e.g. track_05IvjZ0RI7vs).")),
		mcp.WithNumber("start_ms", mcp.Required(), mcp.Description("Fragment start in ms.")),
		mcp.WithNumber("end_ms", mcp.Required(), mcp.Description("Fragment end in ms.")),
		mcp.WithNumber("pad_ms", mcp.Description("Extra ms on each side for context (default 0).")),
		mcp.WithString("lang", mcp.Description("Restrict to a language.")),
		mcp.WithNumber("limit", mcp.Description("Max chunks (default 10, max 50).")),
	)
	srv.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		trackID, err := req.RequireString("track_id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		start := req.GetInt("start_ms", -1)
		end := req.GetInt("end_ms", -1)
		if start < 0 || end < 0 || end < start {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "start_ms/end_ms required, end_ms >= start_ms", nil), nil
		}
		pad := req.GetInt("pad_ms", 0)
		if pad < 0 {
			pad = 0
		}
		lo := start - pad
		if lo < 0 {
			lo = 0
		}
		hi := end + pad
		lang := req.GetString("lang", "")
		limit := clampLimit(req.GetInt("limit", defaultLimit))
		hits, err := repo.Window(ctx, trackID, lo, hi, lang, limit)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"count": len(hits), "chunks": hits}), nil
	})
}

func clampLimit(n int) int {
	if n <= 0 {
		return defaultLimit
	}
	if n > maxLimit {
		return maxLimit
	}
	return n
}
