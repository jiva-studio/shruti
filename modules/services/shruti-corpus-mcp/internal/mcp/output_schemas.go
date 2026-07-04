package mcpsrv

import "encoding/json"

// output_schemas.go declares the MCP `outputSchema` for every tool, so clients
// (and registries like Glama) know the shape of each tool's structured result.
//
// The 15 data tools wrap their payload in the standard envelope
// {ok, kind, result} (see internal/envelope); their schema is envSchema(result).
// The three MCP-App tools (media_get, lecture_excerpt, excerpt_prepare) emit
// their own flat structuredContent object instead of the envelope.
//
// Schemas are intentionally permissive — objects allow additional properties and
// keep `required` minimal — so an optional field (covers, author, start_ms, …)
// being present or absent never conflicts with the declared shape.

// ── tiny JSON-Schema builders ────────────────────────────────────────────────

var (
	strS    = map[string]any{"type": "string"}
	intS    = map[string]any{"type": "integer"}
	numS    = map[string]any{"type": "number"}
	boolS   = map[string]any{"type": "boolean"}
	nullStr = map[string]any{"type": []string{"string", "null"}}
)

// obj builds an object schema that also permits unlisted properties.
func obj(props map[string]any, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": props, "additionalProperties": true}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

// arr builds an array schema over items.
func arr(items map[string]any) map[string]any {
	return map[string]any{"type": "array", "items": items}
}

// ── shared fragments ─────────────────────────────────────────────────────────

func sourceRef() map[string]any { return obj(map[string]any{"id": strS, "code": strS, "name": strS}) }
func entityRef() map[string]any { return obj(map[string]any{"id": strS, "name": strS}) }
func sourceMatch() map[string]any {
	return obj(map[string]any{"id": strS, "code": strS, "name": strS, "score": numS}, "id")
}
func entityMatch() map[string]any {
	return obj(map[string]any{"id": strS, "name": strS, "score": numS}, "id")
}

// listResult is the {items, next_cursor} shape shared by every *_list tool.
func listResult(item map[string]any) map[string]any {
	return obj(map[string]any{"items": arr(item), "next_cursor": nullStr}, "items")
}

// matchesResult is the {matches} shape shared by every *_resolve tool.
func matchesResult(match map[string]any) map[string]any {
	return obj(map[string]any{"matches": arr(match)}, "matches")
}

// ── per-tool result payloads ─────────────────────────────────────────────────

func sourceObj() map[string]any {
	return obj(map[string]any{
		"id": strS, "code": strS, "name": strS,
		"token_scheme": strS, "has_commentary": boolS, "verse_count": intS,
	}, "id")
}

func searchResult() map[string]any {
	// A hit is a union (verse | document | track | title | media); list the
	// possible fields and allow the rest.
	hit := obj(map[string]any{
		"type": strS, "score": numS, "ref": strS, "source": sourceRef(),
		"tokens": strS, "snippet": strS, "lang": strS,
		"verse_id": strS, "document_id": strS, "kind": strS, "author": entityRef(),
		"track_id": strS, "media_id": strS, "url": strS,
		"start_ms": intS, "end_ms": intS, "track": obj(map[string]any{}),
	}, "type")
	return obj(map[string]any{"count": intS, "hits": arr(hit)}, "count", "hits")
}

func verseObj() map[string]any {
	return obj(map[string]any{
		"id": strS, "ref": strS, "source": sourceRef(), "tokens": strS, "covers": strS,
	}, "id")
}

func verseListItem() map[string]any {
	return obj(map[string]any{
		"id": strS, "ref": strS, "source": sourceRef(), "tokens": strS,
		"translation_preview": strS, "covers": strS,
	}, "id")
}

func documentObj() map[string]any {
	return obj(map[string]any{
		"id": strS, "ref": strS, "source": sourceRef(), "tokens": strS,
		"kind": strS, "author": entityRef(),
	}, "id")
}

func trackObj() map[string]any {
	return obj(map[string]any{
		"track_id": strS, "references": arr(obj(map[string]any{})),
		"has_transcript": boolS, "has_pdf": boolS,
	})
}

func transcriptWindowResult() map[string]any {
	chunk := obj(map[string]any{"text": strS, "lang": strS, "start_ms": intS, "end_ms": intS}, "text")
	return obj(map[string]any{"count": intS, "chunks": arr(chunk)}, "count", "chunks")
}

// App-tool payloads (flat structuredContent, not the envelope).

func mediaGetObj() map[string]any {
	return obj(map[string]any{
		"id": strS, "type": strS, "url": strS, "poster": strS, "title": strS,
	}, "id", "url")
}

func lectureExcerptObj() map[string]any {
	return obj(map[string]any{
		"track_id": strS, "title": strS, "author": strS, "date": strS,
		"start_ms": intS, "end_ms": intS, "excerpt_id": strS,
	}, "track_id", "excerpt_id")
}

func excerptPrepareObj() map[string]any {
	return obj(map[string]any{"url": strS, "ready": boolS, "excerpt_id": strS}, "url", "excerpt_id")
}

// ── envelope wrapper + dispatch ───────────────────────────────────────────────

// envSchema wraps a result payload in the standard {ok, kind, result, error}
// envelope schema.
func envSchema(result map[string]any) json.RawMessage {
	errObj := obj(map[string]any{
		"code": strS, "message": strS, "details": map[string]any{"type": "object"},
	}, "code", "message")
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"ok": boolS, "kind": strS, "result": result, "error": errObj,
		},
		"required":             []string{"ok", "kind"},
		"additionalProperties": false,
	}
	b, _ := json.Marshal(schema)
	return b
}

// rawSchema marshals a flat (non-enveloped) object schema for an App tool.
func rawSchema(o map[string]any) json.RawMessage {
	b, _ := json.Marshal(o)
	return b
}

// outputSchemaFor returns the outputSchema for a tool kind, or nil if unknown
// (in which case no outputSchema is emitted for that tool).
func outputSchemaFor(kind string) json.RawMessage {
	switch kind {
	case "search":
		return envSchema(searchResult())
	case "source_get":
		return envSchema(sourceObj())
	case "source_list":
		return envSchema(listResult(sourceObj()))
	case "source_resolve":
		return envSchema(matchesResult(sourceMatch()))
	case "author_list", "location_list":
		return envSchema(listResult(entityRef()))
	case "author_resolve", "location_resolve":
		return envSchema(matchesResult(entityMatch()))
	case "verse_get":
		return envSchema(verseObj())
	case "verse_list":
		return envSchema(listResult(verseListItem()))
	case "document_get":
		return envSchema(documentObj())
	case "document_list":
		return envSchema(listResult(documentObj()))
	case "track_get":
		return envSchema(trackObj())
	case "track_list":
		return envSchema(listResult(trackObj()))
	case "transcript_window":
		return envSchema(transcriptWindowResult())
	case "media_get":
		return rawSchema(mediaGetObj())
	case "lecture_excerpt":
		return rawSchema(lectureExcerptObj())
	case "excerpt_prepare":
		return rawSchema(excerptPrepareObj())
	}
	return nil
}
