package tools

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/catalog/proactive"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/mcp/envelope"
)

func TestRequireInt(t *testing.T) {
	cases := []struct {
		name    string
		args    map[string]any
		key     string
		want    int
		wantErr string
	}{
		{"float64 happy path", map[string]any{"x": float64(42)}, "x", 42, ""},
		{"int passes", map[string]any{"x": 7}, "x", 7, ""},
		{"missing", map[string]any{}, "x", 0, "is required"},
		{"wrong type", map[string]any{"x": "nope"}, "x", 0, "must be a number"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := requireInt(tc.args, tc.key)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("got err %v", err)
				}
				if got != tc.want {
					t.Fatalf("got %d, want %d", got, tc.want)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("got %v, want substring %q", err, tc.wantErr)
			}
		})
	}
}

// envelopeFromError keeps the codes consistent with the project-wide
// convention: ValidationError -> validation_failed, NotFoundError ->
// not_found, everything else -> internal. The MCP layer reads `error.code`
// to decide retry / surfacing — getting this wrong sends users to the
// wrong remediation.
func TestEnvelopeFromError_classifies(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		wantCode envelope.Code
	}{
		{"validation", &proactive.ValidationError{Field: "date", Message: "must be YYYY-MM-DD"}, envelope.CodeValidationFailed},
		{"not found", &proactive.NotFoundError{Entity: "holiday", Key: "x"}, envelope.CodeNotFound},
		{"internal", errors.New("disk on fire"), envelope.CodeInternal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := envelopeFromError("catalog.proactive.holiday_add", tc.err)
			if res == nil {
				t.Fatal("nil result")
			}
			// envelope.Err marshals to a text content. Search for the code
			// substring so we don't depend on the exact JSON layout — the
			// envelope package owns formatting.
			content := envelopeText(t, res)
			want := `"code": "` + string(tc.wantCode) + `"`
			if !strings.Contains(content, want) {
				t.Fatalf("code missing in envelope: want %q, got %s", want, content)
			}
		})
	}
}

// envelopeText fishes the JSON body out of a CallToolResult — same trick
// as envelope_test.extractText, duplicated here to avoid an internal/-only
// export.
func envelopeText(t *testing.T, r any) string {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wrapper struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(b, &wrapper); err != nil {
		t.Fatalf("unmarshal: %v: %s", err, b)
	}
	if len(wrapper.Content) == 0 {
		t.Fatalf("no content blocks: %s", b)
	}
	return wrapper.Content[0].Text
}
