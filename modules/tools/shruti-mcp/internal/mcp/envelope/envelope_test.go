package envelope

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestErrorCodeStrings(t *testing.T) {
	// These string values are part of the v2 public surface — clients
	// branch on them. Renaming any of these is a breaking change requiring
	// a major version bump.
	want := map[Code]string{
		CodeInvalidArgument:  "invalid_argument",
		CodeNotFound:         "not_found",
		CodeConflict:         "conflict",
		CodeValidationFailed: "validation_failed",
		CodeDependencyFailed: "dependency_failed",
		CodeInternal:         "internal",
	}
	for code, expected := range want {
		if string(code) != expected {
			t.Errorf("Code %q: got %q, want %q", expected, string(code), expected)
		}
	}
}

func TestResultRoundTrip(t *testing.T) {
	type payload struct {
		ID    string `json:"id"`
		Count int    `json:"count"`
	}
	r := Result("track.commit", payload{ID: "track_X", Count: 7})
	body := extractText(t, r)

	var got struct {
		Ok     bool    `json:"ok"`
		Kind   string  `json:"kind"`
		Result payload `json:"result"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("unmarshal: %v\nbody: %s", err, body)
	}
	if !got.Ok || got.Kind != "track.commit" || got.Result.ID != "track_X" || got.Result.Count != 7 {
		t.Errorf("round-trip mismatch: %+v\nbody: %s", got, body)
	}
}

func TestResultOmitsEmptyPayload(t *testing.T) {
	body := extractText(t, Result("noop.kind", nil))
	if strings.Contains(body, `"result"`) {
		t.Errorf("nil payload should omit result field; got: %s", body)
	}
}

func TestRunRoundTrip(t *testing.T) {
	r := Run("pipeline", map[string]any{
		"id":             "run_abc",
		"kind":           "pipeline",
		"state":          "queued",
		"accepted_count": 42,
		"rejected_count": 0,
	})
	body := extractText(t, r)

	var got struct {
		Ok   bool           `json:"ok"`
		Kind string         `json:"kind"`
		Run  map[string]any `json:"run"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("unmarshal: %v\nbody: %s", err, body)
	}
	if !got.Ok || got.Kind != "pipeline" || got.Run["id"] != "run_abc" {
		t.Errorf("round-trip mismatch: %+v\nbody: %s", got, body)
	}
}

func TestErrRoundTrip(t *testing.T) {
	r := Err("track.commit", CodeValidationFailed, "missing fields", map[string]any{
		"missing": []string{"title", "date"},
	})
	body := extractText(t, r)

	var got struct {
		Ok    bool   `json:"ok"`
		Kind  string `json:"kind"`
		Error struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("unmarshal: %v\nbody: %s", err, body)
	}
	if got.Ok {
		t.Error("error envelope must have ok=false")
	}
	if got.Error.Code != "validation_failed" || got.Error.Message != "missing fields" {
		t.Errorf("error fields wrong: %+v", got.Error)
	}
	if got.Error.Details["missing"] == nil {
		t.Errorf("details lost: %+v", got.Error.Details)
	}
}

func TestErrEmptyCodeDefaultsInternal(t *testing.T) {
	body := extractText(t, Err("x", "", "boom", nil))
	if !strings.Contains(body, `"code": "internal"`) {
		t.Errorf("empty code should default to internal; got: %s", body)
	}
}

func TestErrNilDetailsBecomesEmptyObject(t *testing.T) {
	body := extractText(t, Err("x", CodeNotFound, "missing", nil))
	if !strings.Contains(body, `"details": {}`) {
		t.Errorf("nil details should serialize as empty object; got: %s", body)
	}
}

// extractText pulls the JSON body out of an mcp.CallToolResult by re-marshaling
// it through encoding/json so we don't depend on the upstream type's internal
// shape (the result holds a slice of content blocks; for our envelope we
// always emit exactly one TextContent).
func extractText(t *testing.T, r interface{}) string {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal CallToolResult: %v", err)
	}
	// CallToolResult JSON looks like {"content":[{"type":"text","text":"..."}], ...}.
	// Find the embedded text payload by walking the parsed structure.
	var wrapper struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(b, &wrapper); err != nil {
		t.Fatalf("unmarshal CallToolResult: %v\nraw: %s", err, string(b))
	}
	if len(wrapper.Content) == 0 || wrapper.Content[0].Type != "text" {
		t.Fatalf("expected one text content block, got: %s", string(b))
	}
	return wrapper.Content[0].Text
}
