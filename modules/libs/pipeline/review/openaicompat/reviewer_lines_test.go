package openaicompatreview

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/pipeline/ports/review"
)

// stubUpstream replies with body and records the request the reviewer sent.
func stubUpstream(t *testing.T, body string, seen *map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if seen != nil {
			_ = json.Unmarshal(raw, seen)
		}
		w.Header().Set("Content-Type", "application/json")
		resp := map[string]any{
			"model": "stub/model",
			"choices": []any{map[string]any{
				"message": map[string]any{"role": "assistant", "content": body},
			}},
			"usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func linesReviewer(t *testing.T, endpoint string) *Reviewer {
	t.Helper()
	r, err := New(Config{
		NameAlias: "stub", Endpoint: endpoint, APIKey: "k",
		Model: "stub/model", MaxTokens: 1024, Format: FormatLines,
	})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// The wire carries only what changed; the port contract still hands the use
// case every segment, so nothing downstream has to know about the delta.
func TestReviewChunkLinesReturnsWholeChunk(t *testing.T) {
	var sent map[string]any
	srv := stubUpstream(t, "1|Шри Прабхупада говорил.\nENDS\n1,2", &sent)
	r := linesReviewer(t, srv.URL)

	resp, err := r.ReviewChunk(context.Background(), review.ChunkRequest{
		Language: "ru",
		Segments: []review.ChunkSegment{
			{Idx: 0, Text: "первый"},
			{Idx: 1, Text: "шрипраб упада говорил"},
			{Idx: 2, Text: "третий"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Segments) != 3 {
		t.Fatalf("segments = %d, want the full chunk of 3", len(resp.Segments))
	}
	if resp.Segments[1].Text != "Шри Прабхупада говорил." {
		t.Errorf("idx 1 = %q, want the corrected text", resp.Segments[1].Text)
	}
	if resp.Segments[0].Text != "первый" || resp.Segments[2].Text != "третий" {
		t.Error("unreported segments must keep the text that was sent")
	}
	if len(resp.Sentences) != 2 {
		t.Errorf("sentences = %v, want two groups from boundaries 1,2", resp.Sentences)
	}
	if len(resp.Models) != 1 || resp.Models[0].Role != "single" {
		t.Errorf("models = %+v", resp.Models)
	}
}

func TestReviewChunkLinesUsesLinePrompt(t *testing.T) {
	var sent map[string]any
	srv := stubUpstream(t, "ENDS\n0", &sent)
	r := linesReviewer(t, srv.URL)

	_, err := r.ReviewChunk(context.Background(), review.ChunkRequest{
		Language: "ru",
		Segments: []review.ChunkSegment{{Idx: 0, Text: "текст"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	msgs, _ := sent["messages"].([]any)
	if len(msgs) == 0 {
		t.Fatal("no messages reached the upstream")
	}
	system, _ := msgs[0].(map[string]any)["content"].(string)
	if !strings.Contains(system, "ENDS") {
		t.Error("system prompt does not describe the ENDS section")
	}
	if strings.Contains(system, "Output STRICT JSON ONLY") {
		t.Error("lines format must not ship the JSON contract")
	}
}

// A reply that breaks the boundary contract has to fail the chunk so the
// fallback chain escalates, rather than silently yielding raw ASR.
func TestReviewChunkLinesRejectsBadBoundaries(t *testing.T) {
	srv := stubUpstream(t, "0|Правка.\nENDS\n7", nil)
	r := linesReviewer(t, srv.URL)

	_, err := r.ReviewChunk(context.Background(), review.ChunkRequest{
		Language: "ru",
		Segments: []review.ChunkSegment{{Idx: 0, Text: "текст"}},
	})
	if err == nil {
		t.Fatal("want an error for a boundary outside the chunk")
	}
	if !strings.Contains(err.Error(), "boundary 7") {
		t.Errorf("error = %q", err)
	}
}

func TestNewRejectsUnknownFormat(t *testing.T) {
	_, err := New(Config{
		NameAlias: "stub", Endpoint: "http://example.invalid", APIKey: "k",
		Model: "stub/model", Format: Format("yaml"),
	})
	if err == nil || !strings.Contains(err.Error(), "unknown format") {
		t.Fatalf("err = %v, want an unknown-format error", err)
	}
}
