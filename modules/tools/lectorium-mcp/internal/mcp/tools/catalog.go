package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/refresh"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// CatalogDeps wires the catalog use cases.
type CatalogDeps struct {
	Refresh   refresh.UseCase
	OpenRepo  func(ctx context.Context) (CatalogRepo, error) // lazy-open current.db
}

// CatalogRepo is the read interface used by tools (subset of catalogport.Repository).
type CatalogRepo interface {
	Scheme(ctx context.Context) (int, error)
	GetDict(ctx context.Context, kind catalog.Kind, id string) (catalog.DictEntry, bool, error)
	ListDict(ctx context.Context, kind catalog.Kind, opts catalog.ListOpts) ([]catalog.DictEntry, error)
	UsageCount(ctx context.Context, kind catalog.Kind, id string) (int, error)
	Close() error
}

func RegisterCatalogRefresh(s *server.MCPServer, deps CatalogDeps) {
	const kind = "catalog.refresh"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Download the latest scheme-compatible catalog DB. By default no-op if current.db has unsaved changes; use force=true to overwrite."),
		mcp.WithBoolean("force", mcp.Description("Overwrite current.db even if it has local edits (a backup is made).")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		force := req.GetBool("force", false)
		res, err := deps.Refresh.Run(ctx, force)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}

func RegisterCatalogStatus(s *server.MCPServer, deps CatalogDeps) {
	const kind = "catalog.status"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Show catalog snapshot version, scheme, and counts."),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		repo, err := deps.OpenRepo(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		defer repo.Close()
		scheme, err := repo.Scheme(ctx)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}

		counts := map[string]int{}
		for _, k := range []catalog.Kind{catalog.KindAuthor, catalog.KindLocation, catalog.KindSource, catalog.KindTag} {
			entries, err := repo.ListDict(ctx, k, catalog.ListOpts{Limit: 1_000_000})
			if err != nil {
				return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
			}
			counts[string(k)+"s"] = len(entries)
		}

		return envelope.Result(kind, struct {
			Scheme int            `json:"scheme"`
			Counts map[string]int `json:"dict_counts"`
		}{scheme, counts}), nil
	})
}

func registerDictRead(s *server.MCPServer, deps CatalogDeps, dictKind catalog.Kind, prefix string) {
	listKind := prefix + ".list"
	listTool := mcp.NewTool(listKind,
		mcp.WithDescription(fmt.Sprintf("List %ss (paginated).", dictKind)),
		mcp.WithString("language", mcp.Description("Filter by ISO language code (optional).")),
		mcp.WithString("query", mcp.Description("Substring filter on full_name (optional).")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 100).")),
		mcp.WithString("cursor", mcp.Description("Cursor from previous page.")),
	)
	s.AddTool(listTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		repo, err := deps.OpenRepo(ctx)
		if err != nil {
			return envelope.Err(listKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		defer repo.Close()
		opts := catalog.ListOpts{
			Limit:  int(req.GetFloat("limit", 100)),
			Cursor: req.GetString("cursor", ""),
		}
		if v := req.GetString("language", ""); v != "" {
			opts.Language = &v
		}
		if v := req.GetString("query", ""); v != "" {
			opts.Query = &v
		}
		entries, err := repo.ListDict(ctx, dictKind, opts)
		if err != nil {
			return envelope.Err(listKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		nextCursor := ""
		if opts.Limit > 0 && len(entries) == opts.Limit {
			nextCursor = entries[len(entries)-1].Id
		}
		return envelope.Result(listKind, struct {
			Items      []catalog.DictEntry `json:"items"`
			NextCursor string              `json:"next_cursor,omitempty"`
		}{entries, nextCursor}), nil
	})

	getKind := prefix + ".get"
	getTool := mcp.NewTool(getKind,
		mcp.WithDescription(fmt.Sprintf("Get one %s by id (returns all locales + usage_count).", dictKind)),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(getTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		repo, err := deps.OpenRepo(ctx)
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		defer repo.Close()
		entry, ok, err := repo.GetDict(ctx, dictKind, id)
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(getKind, envelope.CodeNotFound, fmt.Sprintf("%s not found: %s", dictKind, id), nil), nil
		}
		uses, err := repo.UsageCount(ctx, dictKind, id)
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(getKind, struct {
			catalog.DictEntry
			UsageCount int `json:"usage_count"`
		}{entry, uses}), nil
	})
}

func RegisterCatalogReadTools(s *server.MCPServer, deps CatalogDeps) {
	registerDictRead(s, deps, catalog.KindAuthor, "author")
	registerDictRead(s, deps, catalog.KindLocation, "location")
	registerDictRead(s, deps, catalog.KindSource, "source")
	registerDictRead(s, deps, catalog.KindTag, "tag")
}
