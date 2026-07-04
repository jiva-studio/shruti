// Package mcpsrv builds the shruti-corpus-mcp server: metadata for the
// initialize handshake plus the 15 read-only tools (registered in tools.go).
package mcpsrv

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const instructions = `Shruti — public, read-only access to the Shruti ` +
	`corpus of Vedic scripture and recorded lectures.

Scripture: verses (original Devanagari/Bengali + IAST transliteration + ` +
	`translations) and documents (commentaries/purports, prose chapters, letters). ` +
	`Lectures: transcribed talks and conversations with metadata and references.

Addressing: a reference is a book code plus a position, e.g. "BG 2.13", "SB 5.5.3", ` +
	`"CC Madhya 8.128" (Cyrillic codes like "ШБ 5.5.3" also work). Tools that take a ` +
	`reference accept either the "ref" string or a resolved source id + tokens.

How to use the tools:
- search: semantic + lexical search over verses, documents, tracks and titles.
- source.get/list/resolve, author.list/resolve, location.list/resolve: turn a ` +
	`name into an id used by the filters.
- verse.get/list, document.get/list: read scripture. A verse's purport is ` +
	`document.list(source, tokens, kind:"commentary").
- track.get/list, transcript.window: read lectures. Find the spoken moment of a ` +
	`verse with search(types:["track"]) then transcript.window.`

// New builds the MCP server with public metadata for the initialize handshake.
func New(version string) *server.MCPServer {
	return server.NewMCPServer(
		"shruti-corpus-mcp", // serverInfo.name (protocol identifier)
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
