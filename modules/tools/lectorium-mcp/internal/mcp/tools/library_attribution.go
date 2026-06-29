package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	attributionapp "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/library/attribution"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
	sqlitelibrary "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/library/sqlite"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// LibraryAttributionDeps wires the attribution use case for MCP handlers.
// Holds a reference to the Lazy sqlite handle as well so the ref_add tool
// can resolve verses by (source_id, tokens) before passing the verse_id
// to the use case (shortcut convenience for curators).
type LibraryAttributionDeps struct {
	UseCase attributionapp.UseCase
	Library LibraryRepo // for (source_id, tokens) → verse.id resolution on ref_add shortcut
}

func RegisterLibraryAttribution(s *server.MCPServer, deps LibraryAttributionDeps) {
	registerAttributionCreate(s, deps)
	registerAttributionGet(s, deps)
	registerAttributionList(s, deps)
	registerAttributionTriggerAdd(s, deps)
	registerAttributionTriggerRemove(s, deps)
	registerAttributionNoteSet(s, deps)
	registerAttributionNoteRemove(s, deps)
	registerAttributionNoteTranslate(s, deps)
	registerAttributionRefAdd(s, deps)
	registerAttributionRefRemove(s, deps)
	registerAttributionDelete(s, deps)
	registerAttributionImport(s, deps)
}

// ---------- CREATE ----------

func registerAttributionCreate(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.create"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Create a new attribution (kind=pinned, boost, or memory). Auto-translates the source text (and, for memory, the note) into every supported language as a best-effort side-effect."),
		mcp.WithString("kind", mcp.Required(), mcp.Description("pinned | boost | memory")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Source-text language (ISO-639-1, e.g. \"ru\" or \"en\").")),
		mcp.WithString("text", mcp.Required(), mcp.Description("Canonical text: the query phrasing for kind=pinned; the topical label for kind=boost; the first trigger phrase (a concentrated title-like search key) for kind=memory.")),
		mcp.WithString("note", mcp.Description("kind=memory only: the long curator note (background context injected into the answer, never cited). Auto-translated into every language.")),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		kindIn, err := req.RequireString("kind")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		text, err := req.RequireString("text")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		ak := library.AttributionKind(kindIn)
		if ak != library.AttrPinned && ak != library.AttrBoost && ak != library.AttrMemory {
			return envelope.Err(kind, envelope.CodeValidationFailed,
				fmt.Sprintf("invalid kind %q (must be 'pinned', 'boost' or 'memory')", kindIn), nil), nil
		}
		note := req.GetString("note", "")
		id, err := deps.UseCase.Create(ctx, ak, lang, text, note)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		attr, _, err := deps.UseCase.Get(ctx, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, struct {
			ID          string              `json:"id"`
			Attribution library.Attribution `json:"attribution"`
		}{id, attr}), nil
	})
}

// ---------- GET ----------

func registerAttributionGet(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.get"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Fetch an attribution by id (with all text variants and refs)."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		attr, ok, err := deps.UseCase.Get(ctx, id)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		if !ok {
			return envelope.Err(kind, envelope.CodeNotFound, fmt.Sprintf("attribution not found: %s", id), nil), nil
		}
		return envelope.Result(kind, struct {
			Attribution library.Attribution `json:"attribution"`
		}{attr}), nil
	})
}

// ---------- LIST ----------

func registerAttributionList(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.list"
	t := mcp.NewTool(kind,
		mcp.WithDescription("List attributions (paginated). Filter by kind (pinned|boost|memory), by substring match on any text, optionally restricted to a language."),
		mcp.WithString("kind", mcp.Description("pinned | boost | memory")),
		mcp.WithString("query", mcp.Description("Substring match (LIKE) on any text variant.")),
		mcp.WithString("language", mcp.Description("Restrict the query substring-match to this language only.")),
		mcp.WithNumber("limit", mcp.Description("Page size (default 50, max 500).")),
		mcp.WithString("cursor", mcp.Description("Cursor (last seen id) from previous page.")),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		opts := library.ListAttributionsOpts{
			Kind:     library.AttributionKind(req.GetString("kind", "")),
			Query:    req.GetString("query", ""),
			Language: req.GetString("language", ""),
			Limit:    int(req.GetFloat("limit", 50)),
			Cursor:   req.GetString("cursor", ""),
		}
		if opts.Kind != "" && opts.Kind != library.AttrPinned && opts.Kind != library.AttrBoost && opts.Kind != library.AttrMemory {
			return envelope.Err(kind, envelope.CodeValidationFailed,
				fmt.Sprintf("invalid kind filter %q", opts.Kind), nil), nil
		}
		items, err := deps.UseCase.List(ctx, opts)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		nextCursor := ""
		if opts.Limit > 0 && len(items) == opts.Limit {
			nextCursor = items[len(items)-1].ID
		}
		return envelope.Result(kind, struct {
			Items      []library.Attribution `json:"items"`
			NextCursor string                `json:"next_cursor,omitempty"`
		}{items, nextCursor}), nil
	})
}

// ---------- TRIGGER ADD ----------

func registerAttributionTriggerAdd(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.trigger_add"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Add one trigger phrase (a short search key) to an attribution. Duplicate (id, language, text) is a graceful no-op."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("text", mcp.Required()),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		text, err := req.RequireString("text")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.TextAdd(ctx, id, lang, text); err != nil {
			return mapAttributionError(kind, err), nil
		}
		attr, _, _ := deps.UseCase.Get(ctx, id)
		return envelope.Result(kind, struct {
			Attribution library.Attribution `json:"attribution"`
		}{attr}), nil
	})
}

// ---------- TRIGGER REMOVE ----------

func registerAttributionTriggerRemove(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.trigger_remove"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Remove one specific trigger phrase. No-op if absent."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("text", mcp.Required()),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, _ := req.RequireString("id")
		lang, _ := req.RequireString("language")
		text, _ := req.RequireString("text")
		if id == "" || lang == "" || text == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "id, language, text required", nil), nil
		}
		if err := deps.UseCase.TextRemove(ctx, id, lang, text); err != nil {
			return mapAttributionError(kind, err), nil
		}
		attr, _, _ := deps.UseCase.Get(ctx, id)
		return envelope.Result(kind, struct {
			Attribution library.Attribution `json:"attribution"`
		}{attr}), nil
	})
}

// ---------- NOTE SET / REMOVE / TRANSLATE (memory) ----------

func registerAttributionNoteSet(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.note_set"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Set (upsert) the note for a memory attribution in one language. One note per language — re-setting replaces it. The note is injected as non-citable background context."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
		mcp.WithString("note", mcp.Required()),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, _ := req.RequireString("id")
		lang, _ := req.RequireString("language")
		note, _ := req.RequireString("note")
		if id == "" || lang == "" || note == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "id, language, note required", nil), nil
		}
		if err := deps.UseCase.NoteSet(ctx, id, lang, note); err != nil {
			return mapAttributionError(kind, err), nil
		}
		attr, _, _ := deps.UseCase.Get(ctx, id)
		return envelope.Result(kind, struct {
			Attribution library.Attribution `json:"attribution"`
		}{attr}), nil
	})
}

func registerAttributionNoteRemove(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.note_remove"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Remove the note for a memory attribution in one language. No-op if absent."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required()),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, _ := req.RequireString("id")
		lang, _ := req.RequireString("language")
		if id == "" || lang == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "id, language required", nil), nil
		}
		if err := deps.UseCase.NoteRemove(ctx, id, lang); err != nil {
			return mapAttributionError(kind, err), nil
		}
		attr, _, _ := deps.UseCase.Get(ctx, id)
		return envelope.Result(kind, struct {
			Attribution library.Attribution `json:"attribution"`
		}{attr}), nil
	})
}

func registerAttributionNoteTranslate(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.note_translate"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Translate memory notes from one language to another (e.g. ru→en). Fills only MISSING target notes — never overwrites an existing one. With no ids, walks every memory attribution."),
		mcp.WithString("from", mcp.Required(), mcp.Description("Source language (ISO-639-1).")),
		mcp.WithString("to", mcp.Required(), mcp.Description("Target language (ISO-639-1).")),
		mcp.WithString("ids", mcp.Description("Optional comma-separated attribution ids to limit the run. Empty = all memory attributions.")),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		from, _ := req.RequireString("from")
		to, _ := req.RequireString("to")
		if from == "" || to == "" {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "from and to required", nil), nil
		}
		var ids []string
		if raw := req.GetString("ids", ""); raw != "" {
			for _, p := range strings.Split(raw, ",") {
				if id := strings.TrimSpace(p); id != "" {
					ids = append(ids, id)
				}
			}
		}
		written, err := deps.UseCase.NoteTranslate(ctx, from, to, ids)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, struct {
			Translated int `json:"translated"`
		}{written}), nil
	})
}

// ---------- REF ADD ----------

func registerAttributionRefAdd(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.ref_add"
	t := mcp.NewTool(kind,
		mcp.WithDescription(
			"Attach a ref (verse, document, title or track) to an attribution. Accepts these input shapes:\n"+
				"  1. {ref_kind, target_id}                   — direct opaque id\n"+
				"  2. {ref_kind=verse, source_id, tokens}    — shortcut for verses (MCP resolves to verse.id)\n"+
				"  3. {ref_kind=document, document_id}        — shortcut for documents (same as direct target_id)\n"+
				"  4. {ref_kind=title, source_id, tokens}    — a chapter/canto heading (library_titles), e.g. source_NoY8sAlXF1IT + \"7.5\". Use for verse-structured books (SB/BG/CC) where a chapter is not a document.\n"+
				"  5. {ref_kind=track, track_id, start_ms, end_ms} — a FRAGMENT of a lecture transcript (the chunk(s) covering that time range). Whole-lecture refs are not supported — point at the specific passage.\n"+
				"Existence is validated against library.db; missing target → validation_failed."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Attribution id.")),
		mcp.WithString("ref_kind", mcp.Required(), mcp.Description("verse | document | title | track")),
		mcp.WithString("target_id", mcp.Description("Direct opaque ID (verse.id / library_document.id, or a precomposed track \"<track_id>@<start_ms>-<end_ms>\"). Mutually exclusive with the shortcut params.")),
		mcp.WithString("source_id", mcp.Description("For ref_kind=verse or ref_kind=title shortcut: catalog source id (e.g. source_dsicuBsFvinZ).")),
		mcp.WithString("tokens", mcp.Description("For ref_kind=verse shortcut: verse address (e.g. \"2.13\"). For ref_kind=title: chapter/canto address (e.g. \"7\" or \"7.5\").")),
		mcp.WithString("document_id", mcp.Description("For ref_kind=document shortcut: library_document_<id>.")),
		mcp.WithString("track_id", mcp.Description("For ref_kind=track shortcut: lecture track id (e.g. track_05IvjZ0RI7vs).")),
		mcp.WithNumber("start_ms", mcp.Description("For ref_kind=track shortcut: fragment start in ms.")),
		mcp.WithNumber("end_ms", mcp.Description("For ref_kind=track shortcut: fragment end in ms.")),
		mcp.WithString("language", mcp.Description("Optional answer-language scope (ISO-639-1). Empty = applies to every language (e.g. a verse). Set it for language-specific refs like an EN vs RU lecture of the same talk.")),
		mcp.WithNumber("position", mcp.Description("Ordering hint within the attribution (default 0).")),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		refKind, err := req.RequireString("ref_kind")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !validRefKind(refKind) {
			return envelope.Err(kind, envelope.CodeValidationFailed,
				fmt.Sprintf("invalid ref_kind %q (must be 'verse', 'document', 'title' or 'track')", refKind), nil), nil
		}
		target, err := resolveRefTarget(ctx, deps, refKind, req)
		if err != nil {
			return envelope.Err(kind, envelope.CodeValidationFailed, err.Error(), nil), nil
		}
		ref := library.AttributionRef{
			Kind:     refKind,
			TargetID: target,
			Language: req.GetString("language", ""),
			Position: int(req.GetFloat("position", 0)),
		}
		if err := deps.UseCase.RefAdd(ctx, id, ref); err != nil {
			return mapAttributionError(kind, err), nil
		}
		attr, _, _ := deps.UseCase.Get(ctx, id)
		return envelope.Result(kind, struct {
			Attribution library.Attribution `json:"attribution"`
		}{attr}), nil
	})
}

// ---------- REF REMOVE ----------

func registerAttributionRefRemove(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.ref_remove"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Detach a ref. Accepts the same input shapes as ref_add."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("ref_kind", mcp.Required()),
		mcp.WithString("target_id"),
		mcp.WithString("source_id"),
		mcp.WithString("tokens"),
		mcp.WithString("document_id"),
		mcp.WithString("track_id"),
		mcp.WithNumber("start_ms"),
		mcp.WithNumber("end_ms"),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		refKind, err := req.RequireString("ref_kind")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !validRefKind(refKind) {
			return envelope.Err(kind, envelope.CodeValidationFailed,
				fmt.Sprintf("invalid ref_kind %q", refKind), nil), nil
		}
		target, err := resolveRefTarget(ctx, deps, refKind, req)
		if err != nil {
			return envelope.Err(kind, envelope.CodeValidationFailed, err.Error(), nil), nil
		}
		if err := deps.UseCase.RefRemove(ctx, id, library.AttributionRef{
			Kind: refKind, TargetID: target,
		}); err != nil {
			return mapAttributionError(kind, err), nil
		}
		attr, _, _ := deps.UseCase.Get(ctx, id)
		return envelope.Result(kind, struct {
			Attribution library.Attribution `json:"attribution"`
		}{attr}), nil
	})
}

// ---------- DELETE ----------

func registerAttributionDelete(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.delete"
	t := mcp.NewTool(kind,
		mcp.WithDescription("Delete an attribution; cascades to texts and refs."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.Delete(ctx, id); err != nil {
			return mapAttributionError(kind, err), nil
		}
		return envelope.Result(kind, struct {
			Deleted bool `json:"deleted"`
		}{true}), nil
	})
}

// ---------- helpers ----------

// resolveRefTarget extracts target_id from the request, accepting either the
// direct form or one of the shortcut shapes. Enforces mutual exclusion.
func resolveRefTarget(ctx context.Context, deps LibraryAttributionDeps, refKind string, req mcp.CallToolRequest) (string, error) {
	target := req.GetString("target_id", "")
	srcID := req.GetString("source_id", "")
	tokens := req.GetString("tokens", "")
	docID := req.GetString("document_id", "")

	if refKind == "verse" {
		switch {
		case target != "" && (srcID != "" || tokens != "" || docID != ""):
			return "", fmt.Errorf("ref_kind=verse: provide either target_id OR (source_id, tokens), not both")
		case target != "":
			return target, nil
		case srcID != "" && tokens != "":
			v, ok, err := deps.Library.GetVerse(ctx, srcID, tokens)
			if err != nil {
				return "", fmt.Errorf("resolve verse: %w", err)
			}
			if !ok {
				return "", fmt.Errorf("verse not found for source_id=%s tokens=%s", srcID, tokens)
			}
			return v.ID, nil
		default:
			return "", fmt.Errorf("ref_kind=verse: must provide target_id OR (source_id, tokens)")
		}
	}
	if refKind == "title" {
		// A title ref addresses a library_titles row by (source_id, tokens);
		// the stored target_id is the composite "<source_id>/<tokens>".
		// Existence is validated in the repo layer.
		switch {
		case target != "" && (srcID != "" || tokens != "" || docID != ""):
			return "", fmt.Errorf("ref_kind=title: provide either target_id OR (source_id, tokens), not both")
		case target != "":
			return target, nil
		case srcID != "" && tokens != "":
			return srcID + "/" + tokens, nil
		default:
			return "", fmt.Errorf("ref_kind=title: must provide target_id OR (source_id, tokens)")
		}
	}
	if refKind == "track" {
		// A track ref addresses a FRAGMENT of a lecture by time range:
		// target_id = "<track_id>@<start_ms>-<end_ms>". The chat service
		// resolves it via the transcript-chunk overlap window. Whole-lecture
		// refs are intentionally unsupported — a lecture covers many topics,
		// so attribution is always to a specific passage.
		trackID := req.GetString("track_id", "")
		switch {
		case target != "" && trackID != "":
			return "", fmt.Errorf("ref_kind=track: provide either target_id OR (track_id, start_ms, end_ms), not both")
		case target != "":
			return target, nil
		case trackID != "":
			startMs := int(req.GetFloat("start_ms", -1))
			endMs := int(req.GetFloat("end_ms", -1))
			if startMs < 0 || endMs < 0 || endMs < startMs {
				return "", fmt.Errorf("ref_kind=track: start_ms and end_ms are required (end_ms >= start_ms)")
			}
			return fmt.Sprintf("%s@%d-%d", trackID, startMs, endMs), nil
		default:
			return "", fmt.Errorf("ref_kind=track: must provide target_id OR (track_id, start_ms, end_ms)")
		}
	}
	// document
	switch {
	case target != "" && (srcID != "" || tokens != "" || docID != ""):
		return "", fmt.Errorf("ref_kind=document: provide either target_id OR document_id, not both")
	case target != "":
		return target, nil
	case docID != "":
		return docID, nil
	default:
		return "", fmt.Errorf("ref_kind=document: must provide target_id OR document_id")
	}
}

func validRefKind(k string) bool {
	return k == "verse" || k == "document" || k == "title" || k == "track"
}

func mapAttributionError(kind string, err error) *mcp.CallToolResult {
	switch {
	case errors.Is(err, sqlitelibrary.ErrAttributionNotFound):
		return envelope.Err(kind, envelope.CodeNotFound, err.Error(), nil)
	case errors.Is(err, sqlitelibrary.ErrRefTargetNotFound):
		return envelope.Err(kind, envelope.CodeValidationFailed, err.Error(), nil)
	default:
		return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil)
	}
}
