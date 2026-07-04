// Package mcpsrv builds the lectorium-corpus-mcp server: metadata for the
// initialize handshake plus the 15 read-only tools (registered in tools.go).
package mcpsrv

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const instructions = `Shruti — public, read-only access to the Lectorium ` +
	`corpus of Vedic scripture and recorded lectures.

Scripture: verses (original Devanagari/Bengali + IAST transliteration + ` +
	`translations) and documents (commentaries/purports, prose chapters, letters). ` +
	`Lectures: transcribed talks and conversations with metadata and references.

Addressing: a reference is a book code plus a position, e.g. "BG 2.13", "SB 5.5.3", ` +
	`"CC Madhya 8.128" (Cyrillic codes like "ШБ 5.5.3" also work). Tools that take a ` +
	`reference accept either the "ref" string or a resolved source id + tokens. In the ` +
	`tokens filter (search / track_list / verse_list), a BARE CHAPTER number covers the ` +
	`whole chapter — use "7" for all of chapter 7, "7.1" only for that one verse.

How to use the tools:
- search: semantic + lexical search over verses, documents, tracks and titles.
- source_get/list/resolve, author_list/resolve, location_list/resolve: turn a ` +
	`name into an id used by the filters.
- verse_get/list, document_get/list: read scripture. A verse's purport is ` +
	`document_list(source, tokens, kind:"commentary").
- track_get/list, transcript_window: read lectures. Find the spoken moment of a ` +
	`verse with search(types:["track"]) then transcript_window.

Inline players (render an interactive UI, not just text):
- To SHOW a video clip the user wants to WATCH — from a search(types:["media"]) ` +
	`hit — call media_get(id) with the hit's media_id. It renders an inline video player.
- To let the user HEAR a lecture passage — from a search(types:["track"]) hit — call ` +
	`lecture_excerpt(track_id, start_ms, end_ms). It renders an inline audio player that ` +
	`generates and plays that exact passage (max 10 minutes).`

// New builds the MCP server with public metadata for the initialize handshake.
func New(version string) *server.MCPServer {
	return server.NewMCPServer(
		"lectorium-corpus-mcp", // serverInfo.name (protocol identifier)
		version,
		server.WithToolCapabilities(true),
		server.WithInstructions(instructions),
		server.WithTitle("Shruti"), // serverInfo.title (display name)
		server.WithIcons(mcp.Icon{
			Src:      "https://shruti.app/app-icon.png",
			MIMEType: "image/png",
		}),
	)
}
