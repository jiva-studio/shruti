package mcpsrv

import (
	"encoding/json"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

// allKinds is every registered tool name.
var allKinds = []string{
	"search", "source_get", "source_list", "source_resolve",
	"author_list", "author_resolve", "location_list", "location_resolve",
	"verse_get", "verse_translation", "verse_synonyms", "verse_list", "document_get", "document_list",
	"track_get", "track_list", "transcript_window",
	"media_get", "lecture_excerpt", "excerpt_prepare",
}

// TestOutputSchemaForAllTools checks every tool declares a valid object
// outputSchema and that it is actually emitted in the tool's tools/list JSON.
func TestOutputSchemaForAllTools(t *testing.T) {
	if len(allKinds) != len(toolTitles) {
		t.Fatalf("allKinds has %d entries, toolTitles has %d — keep them in sync", len(allKinds), len(toolTitles))
	}
	for _, k := range allKinds {
		if _, ok := toolTitles[k]; !ok {
			t.Errorf("%s: missing from toolTitles", k)
		}
		raw := outputSchemaFor(k)
		if raw == nil {
			t.Errorf("%s: outputSchemaFor returned nil", k)
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Errorf("%s: invalid schema JSON: %v", k, err)
			continue
		}
		if m["type"] != "object" {
			t.Errorf("%s: top-level type=%v, want object", k, m["type"])
		}
		// Envelope tools must carry the {ok, kind, result} shape.
		if k != "media_get" && k != "lecture_excerpt" && k != "excerpt_prepare" {
			props, _ := m["properties"].(map[string]any)
			for _, want := range []string{"ok", "kind", "result"} {
				if _, ok := props[want]; !ok {
					t.Errorf("%s: envelope schema missing property %q", k, want)
				}
			}
		}
		// The schema must survive into the marshaled tool as outputSchema.
		tool := mcp.NewTool(k, mcp.WithRawOutputSchema(raw))
		b, err := json.Marshal(tool)
		if err != nil {
			t.Errorf("%s: tool marshal: %v", k, err)
			continue
		}
		var tj map[string]any
		if err := json.Unmarshal(b, &tj); err != nil {
			t.Errorf("%s: tool JSON invalid: %v", k, err)
			continue
		}
		if _, ok := tj["outputSchema"]; !ok {
			t.Errorf("%s: outputSchema missing from tool JSON", k)
		}
	}
}
