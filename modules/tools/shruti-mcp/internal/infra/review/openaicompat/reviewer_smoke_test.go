//go:build smoke

package openaicompatreview

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/review"
)

// TestOpenAICompatReviewer_RealOpenRouter hits OpenRouter for one short
// chunk and asserts the response shape (idx-set preserved, models[]
// populated with non-zero tokens). Skipped unless OPENROUTER_API_KEY is
// set in the env. Run with: go test -tags=smoke ./internal/infra/review/openaicompat/.
func TestOpenAICompatReviewer_RealOpenRouter(t *testing.T) {
	key := os.Getenv("OPENROUTER_API_KEY")
	if key == "" {
		t.Skip("OPENROUTER_API_KEY not set")
	}

	r, err := New(Config{
		NameAlias: "gemini-3.1-flash-lite",
		Endpoint:  "https://openrouter.ai/api/v1",
		APIKey:    key,
		Model:     "google/gemini-3.1-flash-lite",
		MaxTokens: 4096,
		Reasoning: ReasoningOff,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	req := review.ChunkRequest{
		Language: "en",
		Segments: []review.ChunkSegment{
			{Idx: 0, Text: "the time of death is a sacred moment.", Confidence: 0.9},
			{Idx: 1, Text: "Krishna says, ja prayati tajanadhi hang sajati.", Confidence: 0.5},
			{Idx: 2, Text: "this verse appears in the bhagavad gita.", Confidence: 0.95},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	resp, err := r.ReviewChunk(ctx, req)
	if err != nil {
		t.Fatalf("ReviewChunk: %v", err)
	}

	if len(resp.Segments) != 3 {
		t.Errorf("got %d segments, want 3", len(resp.Segments))
	}
	got := map[int]bool{}
	for _, s := range resp.Segments {
		got[s.Idx] = true
	}
	for i := 0; i < 3; i++ {
		if !got[i] {
			t.Errorf("missing idx %d in response", i)
		}
	}
	if len(resp.Models) != 1 {
		t.Fatalf("got %d Models entries, want 1", len(resp.Models))
	}
	m := resp.Models[0]
	if m.Role != "single" {
		t.Errorf("role = %q, want single", m.Role)
	}
	if m.ModelID != "google/gemini-3.1-flash-lite" {
		t.Errorf("model_id = %q, want google/gemini-3.1-flash-lite", m.ModelID)
	}
	if m.TokensIn == 0 || m.TokensOut == 0 {
		t.Errorf("tokens not populated: in=%d out=%d", m.TokensIn, m.TokensOut)
	}
	t.Logf("OK: model=%s tokens_in=%d tokens_out=%d cost_usd=%g",
		m.ModelID, m.TokensIn, m.TokensOut, m.CostUSD)
	for _, s := range resp.Segments {
		t.Logf("  [%d] %s", s.Idx, s.Text)
	}
}
