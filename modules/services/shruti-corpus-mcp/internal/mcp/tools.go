package mcpsrv

import (
	"github.com/mark3labs/mcp-go/server"
)

// toolTitles are the human-readable display names (MCP `title` annotation)
// clients show instead of the raw underscore tool name.
var toolTitles = map[string]string{
	"search":            "Search",
	"source_get":        "Get book",
	"source_list":       "List books",
	"source_resolve":    "Find book",
	"author_list":       "List authors",
	"author_resolve":    "Find author",
	"location_list":     "List locations",
	"location_resolve":  "Find location",
	"verse_get":         "Get verse",
	"verse_translation": "Get translation",
	"verse_synonyms":    "Word-by-word",
	"verse_list":        "List verses",
	"document_get":      "Get document",
	"document_list":     "List documents",
	"track_get":         "Get lecture",
	"track_list":        "List lectures",
	"transcript_window": "Read transcript",
	"verse_render":      "Show verse",
	"media_render":      "Play video",
	"excerpt_render":    "Play excerpt",
	"excerpt_prepare":   "Prepare excerpt audio",
}

// RegisterTools wires the read-only tools, one file per family (tools_*.go),
// plus the MCP-App render tools and their UI resources onto srv.
func RegisterTools(srv *server.MCPServer, d *Deps) {
	registerSearch(srv, d)
	registerSourceGet(srv, d)
	registerSourceList(srv, d)
	registerSourceResolve(srv, d)
	registerAuthorList(srv, d)
	registerAuthorResolve(srv, d)
	registerLocationList(srv, d)
	registerLocationResolve(srv, d)
	registerVerseGet(srv, d)
	registerVerseTranslation(srv, d)
	registerVerseSynonyms(srv, d)
	registerVerseList(srv, d)
	registerDocumentGet(srv, d)
	registerDocumentList(srv, d)
	registerTrackGet(srv, d)
	registerTrackList(srv, d)
	registerTranscriptWindow(srv, d)
	// MCP Apps: the two interactive UI render-tools + their UI resources.
	registerApps(srv, d)
}
