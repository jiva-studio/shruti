//go:build smoke

package gemini

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestFetchRealJob parses a job that actually ran, which is the only way to
// know the wire types match what Google sends rather than what the docs say.
// Needs GEMINI_API_KEY and GEMINI_BATCH_NAME (e.g. batches/057olch3...).
// Run: go test -tags=smoke -run RealJob ./review/gemini/.
func TestFetchRealJob(t *testing.T) {
	key, name := os.Getenv("GEMINI_API_KEY"), os.Getenv("GEMINI_BATCH_NAME")
	if key == "" || name == "" {
		t.Skip("GEMINI_API_KEY / GEMINI_BATCH_NAME not set")
	}
	c, err := New(Options{APIKey: key, Model: "gemini-flash-lite-latest", Timeout: 2 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	job, res, err := c.Fetch(context.Background(), name)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	t.Logf("job %s state=%s stats=%+v", job.Name, job.State, job.Stats)
	if job.Stats.Total != len(res) {
		t.Errorf("job counts %d requests but returned %d replies", job.Stats.Total, len(res))
	}
	var ok, failed int
	var tin, tout int64
	for _, r := range res {
		if r.Key == "" {
			t.Error("reply without a key — reassembly would lose it")
		}
		if r.Err != nil {
			failed++
			continue
		}
		ok++
		tin += r.TokensIn
		tout += r.TokensOut
	}
	if ok != job.Stats.Successful || failed != job.Stats.Failed {
		t.Errorf("parsed %d ok / %d failed, job says %d / %d",
			ok, failed, job.Stats.Successful, job.Stats.Failed)
	}
	t.Logf("parsed %d ok, %d failed, tokens in=%d out=%d", ok, failed, tin, tout)
	if ok > 0 && tin == 0 {
		t.Error("usage metadata did not parse")
	}
}
