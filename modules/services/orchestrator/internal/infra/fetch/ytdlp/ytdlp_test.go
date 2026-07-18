package ytdlp

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/orchestrator/internal/domain/ingest"
)

func TestBreaker_OpensAfterThresholdAndRecovers(t *testing.T) {
	now := time.Now()
	b := newBreaker(2, time.Minute)
	b.now = func() time.Time { return now }

	if !b.allow() {
		t.Fatal("breaker should start closed")
	}
	b.record(false)
	b.record(false) // reaches threshold → opens
	if b.allow() {
		t.Fatal("breaker should be open after threshold failures")
	}
	// After the cooldown it half-opens.
	now = now.Add(2 * time.Minute)
	if !b.allow() {
		t.Fatal("breaker should allow a probe after cooldown")
	}
	b.record(true) // success closes it
	if !b.allow() {
		t.Fatal("breaker should be closed after a success")
	}
}

func TestFetch_CircuitOpenShortCircuits(t *testing.T) {
	f := New(Options{
		Runner: func(context.Context, string, ...string) ([]byte, error) {
			return nil, context.DeadlineExceeded // always fail
		},
		BreakerN: 1,
	})
	// First call fails (opening the breaker); the second short-circuits.
	_, _, _ = f.Fetch(context.Background(), "https://example.com/watch?v=1")
	if _, _, err := f.Fetch(context.Background(), "https://example.com/watch?v=1"); err != ErrCircuitOpen {
		t.Fatalf("expected ErrCircuitOpen, got %v", err)
	}
}

func TestRegistry_RoutesMp3ToDirectExtractor(t *testing.T) {
	f := New(Options{})
	mp3, _ := url.Parse("https://cdn.example.com/talk.mp3")
	other, _ := url.Parse("https://youtube.com/watch?v=1")

	if _, ok := f.reg.pick(mp3).(*mp3Extractor); !ok {
		t.Fatal(".mp3 URL should route to the direct-mp3 extractor")
	}
	if _, ok := f.reg.pick(other).(*ytdlpExtractor); !ok {
		t.Fatal("non-mp3 URL should route to the yt-dlp extractor")
	}
}

func TestFetch_RejectsOverlongSource(t *testing.T) {
	f := New(Options{
		MaxSeconds: 60,
		Runner: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			// The duration probe uses --print duration.
			for _, a := range args {
				if a == "duration" {
					return []byte("120\n"), nil // 120s > 60s limit
				}
			}
			return nil, nil
		},
	})
	if _, _, err := f.Fetch(context.Background(), "https://youtube.com/watch?v=1"); err == nil {
		t.Fatal("expected duration-limit rejection")
	}
}

func TestContentIDStable(t *testing.T) {
	if ingest.ContentID([]byte("x")) != ingest.ContentID([]byte("x")) {
		t.Fatal("ContentID must be stable")
	}
}
