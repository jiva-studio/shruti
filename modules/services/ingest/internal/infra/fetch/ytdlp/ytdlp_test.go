package ytdlp

import (
	"context"
	"errors"
	"net/url"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/ingest/internal/domain/ingest"
)

// A permanent yt-dlp failure (deleted/private source) is classified
// non-retriable via ingest.ErrPermanent so the orchestrator dead-letters
// instead of burning its retry budget.
func TestFetch_PermanentYtdlpError_IsPermanent(t *testing.T) {
	f := New(Options{
		Runner: func(context.Context, string, ...string) ([]byte, error) {
			return nil, errors.New("ERROR: [youtube] x: Private video. Sign in if you've been granted access")
		},
	})
	_, _, err := f.Fetch(context.Background(), "https://youtube.com/watch?v=1", nil)
	if !errors.Is(err, ingest.ErrPermanent) {
		t.Fatalf("expected ErrPermanent, got %v", err)
	}
}

// A transient yt-dlp failure (network) stays retriable (NOT ErrPermanent).
func TestFetch_TransientYtdlpError_NotPermanent(t *testing.T) {
	f := New(Options{
		Runner: func(context.Context, string, ...string) ([]byte, error) {
			return nil, errors.New("ERROR: unable to download webpage: connection reset by peer")
		},
	})
	_, _, err := f.Fetch(context.Background(), "https://youtube.com/watch?v=1", nil)
	if err == nil || errors.Is(err, ingest.ErrPermanent) {
		t.Fatalf("expected a transient (non-permanent) error, got %v", err)
	}
}

// A malformed URL is a permanent input error.
func TestFetch_InvalidURL_IsPermanent(t *testing.T) {
	f := New(Options{})
	if _, _, err := f.Fetch(context.Background(), "::not a url::", nil); !errors.Is(err, ingest.ErrPermanent) {
		t.Fatalf("expected ErrPermanent for a malformed url, got %v", err)
	}
}

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
	_, _, _ = f.Fetch(context.Background(), "https://example.com/watch?v=1", nil)
	if _, _, err := f.Fetch(context.Background(), "https://example.com/watch?v=1", nil); err != ErrCircuitOpen {
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
	if _, _, err := f.Fetch(context.Background(), "https://youtube.com/watch?v=1", nil); err == nil {
		t.Fatal("expected duration-limit rejection")
	}
}

func TestContentIDStable(t *testing.T) {
	if ingest.ContentID([]byte("x")) != ingest.ContentID([]byte("x")) {
		t.Fatal("ContentID must be stable")
	}
}

// parsePercent reads only our tagged progress lines, clamps to [0,100], and
// rejects anything else yt-dlp prints.
func TestParsePercent(t *testing.T) {
	cases := []struct {
		line string
		want int
		ok   bool
	}{
		{"PCT:  42.3%|12|50", 42, true}, // byte percent wins
		{"PCT:100.0%|NA|NA", 100, true},
		{"PCT: 0.0%|NA|NA", 0, true},
		{"PCT:150%|NA|NA", 100, true},  // clamp
		{"PCT:NA%|12|50", 24, true},    // fragment fallback 12/50
		{"PCT:NA%|50|50", 100, true},   // last fragment
		{"PCT:NA%|NA|NA", 0, false},    // neither measure
		{"PCT:NA%|3|0", 0, false},      // no fragment count
		{"PCT:  42.3%", 42, true},      // legacy single-field line still parses
		{"[download] Destination: audio.webm", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := parsePercent(c.line)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parsePercent(%q) = (%d,%v), want (%d,%v)", c.line, got, ok, c.want, c.ok)
		}
	}
}

// The streaming download path forwards yt-dlp's parsed percent to onProgress and
// injects the --progress-template so the tagged lines appear.
func TestDownload_StreamsPercent(t *testing.T) {
	var sawTemplate bool
	f := New(Options{
		ProgressRunner: func(_ context.Context, onLine func(string), _ string, args ...string) error {
			for _, a := range args {
				if a == progressTemplate {
					sawTemplate = true
				}
			}
			onLine("PCT: 25.0%")
			onLine("[download] chatter")
			onLine("PCT: 80.0%")
			return errors.New("no audio artifact") // stop before findAudio's disk read
		},
	})
	var pcts []int
	_, _, _ = f.Fetch(context.Background(), "https://youtube.com/watch?v=1", func(p int) { pcts = append(pcts, p) })
	if !sawTemplate {
		t.Fatal("streaming download must pass --progress-template")
	}
	if len(pcts) != 2 || pcts[0] != 25 || pcts[1] != 80 {
		t.Fatalf("onProgress got %v, want [25 80]", pcts)
	}
}
