package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
	catalogport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/catalog"
)

// FindDeps wires the resolver chain + repo for the *.resolve tools.
type FindDeps struct {
	Catalog  CatalogRepo
	Resolver catalogport.Resolver
	TopN     int
}

func RegisterDictFinds(s *server.MCPServer, deps FindDeps) {
	for _, kp := range []struct {
		kind catalog.Kind
		tool string
	}{
		{catalog.KindAuthor, "author.resolve"},
		{catalog.KindLocation, "location.resolve"},
		{catalog.KindSource, "source.resolve"},
		{catalog.KindTag, "tag.resolve"},
	} {
		registerOneFind(s, deps, kp.kind, kp.tool)
	}
}

func registerOneFind(s *server.MCPServer, deps FindDeps, kind catalog.Kind, name string) {
	tool := mcp.NewTool(name,
		mcp.WithDescription(fmt.Sprintf("LLM-resolve a raw %s string against the catalog. Default response: matched_id?, confidence, reasoning, provider, candidates_count. Pass verbose=true to also return the full candidates[]. Does NOT write to current.db.", kind)),
		mcp.WithString("query", mcp.Required()),
		mcp.WithString("language", mcp.Description("Hint, optional.")),
		mcp.WithBoolean("verbose", mcp.Description("Include full candidates[] in response. Default false (data is already on disk in current.db; use *_list/*_get if needed).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		query, err := req.RequireString("query")
		if err != nil {
			return envelope.Err(name, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		hint := req.GetString("language", "")
		verbose := req.GetBool("verbose", false)

		topN := deps.TopN
		if topN <= 0 {
			topN = 30
		}

		candidates, err := deps.Catalog.ListDict(ctx, kind, catalog.ListOpts{Limit: topN * 4}) // get a wide net; resolver narrows
		if err != nil {
			return envelope.Err(name, envelope.CodeInternal, err.Error(), nil), nil
		}
		// Trim to topN naively (preserve order — repo returns by id sorted).
		if len(candidates) > topN {
			candidates = candidates[:topN]
		}

		resp, err := deps.Resolver.Resolve(ctx, catalogport.ResolveRequest{
			Kind:       kind,
			Query:      query,
			Hint:       hint,
			Candidates: candidates,
		})
		if err != nil {
			return envelope.Err(name, envelope.CodeDependencyFailed, err.Error(), nil), nil
		}
		out := struct {
			MatchedID       string              `json:"matched_id,omitempty"`
			Confidence      string              `json:"confidence"`
			Reasoning       string              `json:"reasoning,omitempty"`
			Provider        string              `json:"provider"`
			CandidatesCount int                 `json:"candidates_count"`
			Candidates      []catalog.DictEntry `json:"candidates,omitempty"`
		}{
			MatchedID:       resp.MatchedID,
			Confidence:      string(resp.Confidence),
			Reasoning:       resp.Reasoning,
			Provider:        resp.Provider,
			CandidatesCount: len(candidates),
		}
		if verbose {
			out.Candidates = candidates
		}
		return envelope.Result(name, out), nil
	})
}
