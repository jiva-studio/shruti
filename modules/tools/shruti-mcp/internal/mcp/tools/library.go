package tools

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/library"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

// LibraryRepo is the read interface the library MCP tools depend on.
type LibraryRepo interface {
	GetVerse(ctx context.Context, sourceID, tokens string) (library.Verse, bool, error)
	GetVerseByID(ctx context.Context, id string) (library.Verse, bool, error)
	ListVerses(ctx context.Context, opts library.ListVersesOpts) ([]library.Verse, error)
	GetDocument(ctx context.Context, id string) (library.Document, bool, error)
	ListDocuments(ctx context.Context, opts library.ListDocumentsOpts) ([]library.Document, error)
	GetTitle(ctx context.Context, sourceID, tokens, language string) (string, bool, error)
	ListTitles(ctx context.Context, opts library.ListTitlesOpts) ([]library.Title, error)
}

// LibraryDeps wires the library use cases.
type LibraryDeps struct {
	Repo LibraryRepo
}

func RegisterLibrary(s *server.MCPServer, deps LibraryDeps) {
	registerLibraryVerse(s, deps)
	registerLibraryDocument(s, deps)
	registerLibraryTitle(s, deps)
}

// ---------- VERSE ----------

func registerLibraryVerse(s *server.MCPServer, deps LibraryDeps) {
	const getKind = "library.verse.get"
	getTool := mcp.NewTool(getKind,
		mcp.WithDescription("Fetch a canonical verse by id OR by (source_id, tokens). Returns original text + transliteration + all language translations."),
		mcp.WithString("id", mcp.Description("Verse id (e.g. verse_XXXXXXXXXXXX). Mutually exclusive with source_id+tokens.")),
		mcp.WithString("source_id", mcp.Description("Catalog source id (e.g. source_dsicuBsFvinZ for Bhagavad-gita).")),
		mcp.WithString("tokens", mcp.Description("Verse address inside the source (e.g. \"2.13\", \"5.5.3\").")),
	)
	s.AddTool(getTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id := req.GetString("id", "")
		srcID := req.GetString("source_id", "")
		tokens := req.GetString("tokens", "")
		if id == "" && (srcID == "" || tokens == "") {
			return envelope.Err(getKind, envelope.CodeInvalidArgument,
				"must provide either id, or both source_id and tokens", nil), nil
		}
		var (
			v   library.Verse
			ok  bool
			err error
		)
		if id != "" {
			v, ok, err = deps.Repo.GetVerseByID(ctx, id)
		} else {
			v, ok, err = deps.Repo.GetVerse(ctx, srcID, tokens)
		}
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(getKind, envelope.CodeNotFound, "verse not found", nil), nil
		}
		return envelope.Result(getKind, v), nil
	})

	const listKind = "library.verse.list"
	listTool := mcp.NewTool(listKind,
		mcp.WithDescription("List verses of a book (paginated). Filter by source_id (required) and optional token prefix."),
		mcp.WithString("source_id", mcp.Required(), mcp.Description("Catalog source id.")),
		mcp.WithString("token_prefix", mcp.Description("Prefix-match on tokens (e.g. \"5.5.\" to limit to SB canto 5 chapter 5).")),
		mcp.WithString("language", mcp.Description("If set, only return the translation for this locale.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 100, max 500).")),
		mcp.WithString("cursor", mcp.Description("Cursor (last seen tokens) from previous page.")),
	)
	s.AddTool(listTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		srcID, err := req.RequireString("source_id")
		if err != nil {
			return envelope.Err(listKind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		opts := library.ListVersesOpts{
			SourceID:    srcID,
			TokenPrefix: req.GetString("token_prefix", ""),
			Language:    req.GetString("language", ""),
			Limit:       int(req.GetFloat("limit", 100)),
			Cursor:      req.GetString("cursor", ""),
		}
		items, err := deps.Repo.ListVerses(ctx, opts)
		if err != nil {
			return envelope.Err(listKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		nextCursor := ""
		if opts.Limit > 0 && len(items) == opts.Limit {
			nextCursor = items[len(items)-1].Tokens
		}
		return envelope.Result(listKind, struct {
			Items      []library.Verse `json:"items"`
			NextCursor string          `json:"next_cursor,omitempty"`
		}{items, nextCursor}), nil
	})
}

// ---------- DOCUMENT ----------

func registerLibraryDocument(s *server.MCPServer, deps LibraryDeps) {
	const getKind = "library.document.get"
	getTool := mcp.NewTool(getKind,
		mcp.WithDescription("Fetch a library document (commentary / prose_chapter / letter) by id. Returns all language bodies + metadata."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Document id (e.g. doc_XXXXXXXXXXXX).")),
	)
	s.AddTool(getTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		d, ok, err := deps.Repo.GetDocument(ctx, id)
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(getKind, envelope.CodeNotFound, fmt.Sprintf("document not found: %s", id), nil), nil
		}
		return envelope.Result(getKind, d), nil
	})

	const listKind = "library.document.list"
	listTool := mcp.NewTool(listKind,
		mcp.WithDescription("List documents (paginated). Filter by source_id, kind (commentary|prose_chapter|letter), author_id, or token prefix."),
		mcp.WithString("source_id", mcp.Description("Filter by catalog source id.")),
		mcp.WithString("kind", mcp.Description("commentary | prose_chapter | letter")),
		mcp.WithString("author_id", mcp.Description("Filter by author id.")),
		mcp.WithString("token_prefix", mcp.Description("Prefix-match on tokens.")),
		mcp.WithString("language", mcp.Description("If set, only return the body for this locale.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 100, max 500).")),
		mcp.WithString("cursor", mcp.Description("Cursor (last seen id) from previous page.")),
	)
	s.AddTool(listTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		opts := library.ListDocumentsOpts{
			SourceID:    req.GetString("source_id", ""),
			Kind:        library.DocumentKind(req.GetString("kind", "")),
			AuthorID:    req.GetString("author_id", ""),
			TokenPrefix: req.GetString("token_prefix", ""),
			Language:    req.GetString("language", ""),
			Limit:       int(req.GetFloat("limit", 100)),
			Cursor:      req.GetString("cursor", ""),
		}
		items, err := deps.Repo.ListDocuments(ctx, opts)
		if err != nil {
			return envelope.Err(listKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		nextCursor := ""
		if opts.Limit > 0 && len(items) == opts.Limit {
			nextCursor = items[len(items)-1].ID
		}
		return envelope.Result(listKind, struct {
			Items      []library.Document `json:"items"`
			NextCursor string             `json:"next_cursor,omitempty"`
		}{items, nextCursor}), nil
	})
}

// ---------- TITLE ----------

func registerLibraryTitle(s *server.MCPServer, deps LibraryDeps) {
	const getKind = "library.title.get"
	getTool := mcp.NewTool(getKind,
		mcp.WithDescription("Get the localized title of a book section (canto / chapter)."),
		mcp.WithString("source_id", mcp.Required()),
		mcp.WithString("tokens", mcp.Required(), mcp.Description("Section address (e.g. \"5\" for canto 5, \"5.5\" for chapter 5.5).")),
		mcp.WithString("language", mcp.Required()),
	)
	s.AddTool(getTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		srcID, err := req.RequireString("source_id")
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		tokens, err := req.RequireString("tokens")
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		t, ok, err := deps.Repo.GetTitle(ctx, srcID, tokens, lang)
		if err != nil {
			return envelope.Err(getKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(getKind, envelope.CodeNotFound,
				fmt.Sprintf("title not found for source_id=%s tokens=%s language=%s", srcID, tokens, lang), nil), nil
		}
		return envelope.Result(getKind, library.Title{
			SourceID: srcID, Tokens: tokens, Language: lang, Title: t,
		}), nil
	})

	const listKind = "library.title.list"
	listTool := mcp.NewTool(listKind,
		mcp.WithDescription("List section titles (paginated). Filter by source_id, language, or token prefix."),
		mcp.WithString("source_id", mcp.Description("Filter by source id.")),
		mcp.WithString("language", mcp.Description("Filter by language.")),
		mcp.WithString("token_prefix", mcp.Description("Prefix-match on tokens.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 200, max 500).")),
	)
	s.AddTool(listTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		opts := library.ListTitlesOpts{
			SourceID:    req.GetString("source_id", ""),
			Language:    req.GetString("language", ""),
			TokenPrefix: req.GetString("token_prefix", ""),
			Limit:       int(req.GetFloat("limit", 200)),
		}
		items, err := deps.Repo.ListTitles(ctx, opts)
		if err != nil {
			return envelope.Err(listKind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(listKind, struct {
			Items []library.Title `json:"items"`
		}{items}), nil
	})
}
