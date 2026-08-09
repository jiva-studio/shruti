package topics

import (
	"context"
	"fmt"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/covergen"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

type fakeCoverLister struct{ items []catalog.TopicCover }

func (f fakeCoverLister) ListTopicCovers(context.Context) ([]catalog.TopicCover, error) {
	return f.items, nil
}

// fakeCoverGen records which ids it was asked to generate. failUntil>0 makes the
// first N calls for a given id fail (to exercise retry); failForever ids always
// fail (to exercise best-effort).
type fakeCoverGen struct {
	mu          sync.Mutex
	calls       map[string]int
	failForever map[string]bool
	failUntil   int
	disabled    bool
}

func newFakeCoverGen() *fakeCoverGen {
	return &fakeCoverGen{calls: map[string]int{}, failForever: map[string]bool{}}
}

func (g *fakeCoverGen) Enabled() bool { return !g.disabled }

func (g *fakeCoverGen) Generate(_ context.Context, id, _, _ string, _ ...covergen.Option) (string, error) {
	g.mu.Lock()
	g.calls[id]++
	n := g.calls[id]
	forever := g.failForever[id]
	g.mu.Unlock()
	if forever || n <= g.failUntil {
		return "", fmt.Errorf("transient image error for %s (attempt %d)", id, n)
	}
	return "public/topics/" + id + "/cover.jpg", nil
}

func threeTopics(covered ...string) fakeCoverLister {
	cov := map[string]bool{}
	for _, c := range covered {
		cov[c] = true
	}
	return fakeCoverLister{items: []catalog.TopicCover{
		{ID: "topic_a", HasCover: cov["topic_a"]},
		{ID: "topic_b", HasCover: cov["topic_b"]},
		{ID: "topic_c", HasCover: cov["topic_c"]},
	}}
}

func TestCoverBuildSkipsAlreadyCovered(t *testing.T) {
	gen := newFakeCoverGen()
	uc := CoverBuildUseCase{Lister: threeTopics("topic_b"), Cover: gen, Concurrency: 2, Retries: 1}
	res, err := uc.Run(context.Background(), false, 0, "en", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 2 || res.Generated != 2 || res.Skipped != 1 || res.Failed != 0 {
		t.Fatalf("got %+v, want total=2 generated=2 skipped=1 failed=0", res)
	}
	if _, hit := gen.calls["topic_b"]; hit {
		t.Fatal("the already-covered topic must not be generated")
	}
}

func TestCoverBuildForceRegeneratesAll(t *testing.T) {
	gen := newFakeCoverGen()
	uc := CoverBuildUseCase{Lister: threeTopics("topic_b"), Cover: gen, Concurrency: 3, Retries: 1}
	res, err := uc.Run(context.Background(), true, 0, "en", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 3 || res.Generated != 3 || res.Skipped != 0 {
		t.Fatalf("got %+v, want total=3 generated=3 skipped=0", res)
	}
}

func TestCoverBuildRetriesTransientFailures(t *testing.T) {
	gen := newFakeCoverGen()
	gen.failUntil = 1 // first attempt per id fails, retry succeeds
	uc := CoverBuildUseCase{Lister: threeTopics(), Cover: gen, Concurrency: 2, Retries: 3}
	res, err := uc.Run(context.Background(), false, 0, "en", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Generated != 3 || res.Failed != 0 {
		t.Fatalf("retry should recover all, got %+v", res)
	}
}

func TestCoverBuildBestEffortRecordsFailures(t *testing.T) {
	gen := newFakeCoverGen()
	gen.failForever["topic_b"] = true
	var progressCalls int32
	uc := CoverBuildUseCase{Lister: threeTopics(), Cover: gen, Concurrency: 1, Retries: 2}
	res, err := uc.Run(context.Background(), false, 0, "en", "",
		func(done, total, failed int) { atomic.AddInt32(&progressCalls, 1) })
	if err != nil {
		t.Fatal(err)
	}
	if res.Generated != 2 || res.Failed != 1 || len(res.FailedIDs) != 1 || res.FailedIDs[0] != "topic_b" {
		t.Fatalf("one failure must not abort the batch, got %+v", res)
	}
	if progressCalls != 3 {
		t.Fatalf("progress should fire once per topic, got %d", progressCalls)
	}
}

func TestCoverBuildLimit(t *testing.T) {
	gen := newFakeCoverGen()
	uc := CoverBuildUseCase{Lister: threeTopics(), Cover: gen, Concurrency: 2, Retries: 1}
	res, err := uc.Run(context.Background(), false, 2, "en", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 2 || res.Generated != 2 {
		t.Fatalf("limit=2 should cap the run, got %+v", res)
	}
}

func TestCoverBuildDisabled(t *testing.T) {
	gen := newFakeCoverGen()
	gen.disabled = true
	uc := CoverBuildUseCase{Lister: threeTopics(), Cover: gen, Concurrency: 1, Retries: 1}
	if _, err := uc.Run(context.Background(), false, 0, "en", "", nil); err == nil {
		t.Fatal("expected an error when the generator is disabled")
	}
}
