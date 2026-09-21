package tools

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/shruti/modules/tools/transcriber-mcp/internal/client"
)

// --- mock JobClient ---

type mockClient struct {
	getJobFn        func(ctx context.Context, jobID string) (*client.Job, error)
	getTranscriptFn func(ctx context.Context, jobID string) (*client.Transcript, error)
	listJobsFn      func(ctx context.Context, status string, limit int) ([]*client.Job, error)
	getHealthFn     func(ctx context.Context) (*client.Health, error)
}

func (m *mockClient) GetJob(ctx context.Context, jobID string) (*client.Job, error) {
	return m.getJobFn(ctx, jobID)
}
func (m *mockClient) GetTranscript(ctx context.Context, jobID string) (*client.Transcript, error) {
	return m.getTranscriptFn(ctx, jobID)
}
func (m *mockClient) ListJobs(ctx context.Context, status string, limit int) ([]*client.Job, error) {
	return m.listJobsFn(ctx, status, limit)
}
func (m *mockClient) GetHealth(ctx context.Context) (*client.Health, error) {
	if m.getHealthFn == nil {
		return nil, nil
	}
	return m.getHealthFn(ctx)
}

// fastCfg compresses the polling intervals for unit tests.
var fastCfg = Config{
	PollFast:    5 * time.Millisecond,
	PollSlow:    5 * time.Millisecond,
	PollFastFor: 100 * time.Millisecond,
	MaxTimeout:  3600 * time.Second,
}

// --- transcribe_wait ---

func TestTranscribeWait_DoneImmediately(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			return &client.Job{JobID: id, Status: client.StatusDone, Confidence: 0.95, DurationSeconds: 100}, nil
		},
		getTranscriptFn: func(_ context.Context, _ string) (*client.Transcript, error) {
			return &client.Transcript{Text: "hello"}, nil
		},
	}
	res, err := waitForJob(t.Context(), mc, "abc", 5*time.Second, fastCfg.withDefaults())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "done" || res.Text != "hello" || res.Confidence != 0.95 {
		t.Errorf("got %+v", res)
	}
	if res.TimedOut {
		t.Error("should not be timed out")
	}
}

func TestTranscribeWait_TransitionsThroughRunning(t *testing.T) {
	calls := 0
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			calls++
			if calls < 3 {
				return &client.Job{JobID: id, Status: client.StatusRunning}, nil
			}
			return &client.Job{JobID: id, Status: client.StatusDone, Confidence: 0.9, DurationSeconds: 30}, nil
		},
		getTranscriptFn: func(_ context.Context, _ string) (*client.Transcript, error) {
			return &client.Transcript{Text: "ok"}, nil
		},
	}
	res, err := waitForJob(t.Context(), mc, "abc", 1*time.Second, fastCfg)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "done" || calls < 3 {
		t.Errorf("got %+v after %d calls", res, calls)
	}
}

func TestTranscribeWait_FailedReturnsError(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			return &client.Job{JobID: id, Status: client.StatusFailed, Error: "ffmpeg failed"}, nil
		},
	}
	res, err := waitForJob(t.Context(), mc, "abc", 5*time.Second, fastCfg.withDefaults())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "failed" || res.Error != "ffmpeg failed" {
		t.Errorf("got %+v", res)
	}
}

func TestTranscribeWait_TimeoutZeroPeeks(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			return &client.Job{JobID: id, Status: client.StatusRunning}, nil
		},
	}
	res, err := waitForJob(t.Context(), mc, "abc", 0, fastCfg)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "running" {
		t.Errorf("got status %s", res.Status)
	}
	// timeout=0 → no extra polling, no timed-out flag (we just peeked).
	if res.TimedOut {
		t.Error("timeout=0 should not set TimedOut=true")
	}
}

func TestTranscribeWait_TimeoutMarksTimedOut(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			return &client.Job{JobID: id, Status: client.StatusRunning}, nil
		},
	}
	res, err := waitForJob(t.Context(), mc, "abc", 50*time.Millisecond, fastCfg)
	if err != nil {
		t.Fatal(err)
	}
	if !res.TimedOut || res.Status != "running" {
		t.Errorf("got %+v", res)
	}
}

func TestTranscribeWait_NotFound(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(_ context.Context, _ string) (*client.Job, error) {
			return nil, client.ErrNotFound
		},
	}
	_, err := waitForJob(t.Context(), mc, "missing", 100*time.Millisecond, fastCfg)
	if !errors.Is(err, client.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

// --- get_transcript handler shape ---

func TestRegisterAll_SchemaSmoke(t *testing.T) {
	// Cheap sanity check: NewTool produces valid tool definitions and AddTool
	// doesn't panic. Full tools/list flow is verified via live MCP smoke test
	// after building the binary.
	mc := &mockClient{
		getJobFn:        func(_ context.Context, _ string) (*client.Job, error) { return nil, nil },
		getTranscriptFn: func(_ context.Context, _ string) (*client.Transcript, error) { return nil, nil },
		listJobsFn:      func(_ context.Context, _ string, _ int) ([]*client.Job, error) { return nil, nil },
		getHealthFn:     func(ctx context.Context) (*client.Health, error) { return &client.Health{}, nil },
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("RegisterAll panicked: %v", r)
		}
	}()
	srv := newTestMCPServer(t)
	RegisterAll(srv, StaticProvider{C: mc, URL_: "http://test", SaveDir_: t.TempDir()}, Config{})
}

// --- helpers ---

func newTestMCPServer(t *testing.T) *server.MCPServer {
	t.Helper()
	return server.NewMCPServer("transcriber-mcp-test", "0.0.0",
		server.WithToolCapabilities(true))
}

// JSON encoder sanity for transcribeWaitResult — make sure omitempty works
// (we don't want empty strings/zeroes flooding the agent's context).
func TestTranscribeWaitResult_OmitEmpty(t *testing.T) {
	r := transcribeWaitResult{JobID: "abc", Status: "running"}
	b, _ := json.Marshal(r)
	got := string(b)
	for _, banned := range []string{`"text":""`, `"confidence":0`, `"duration_s":0`, `"rtfx":0`, `"error":""`} {
		if strings.Contains(got, banned) {
			t.Errorf("expected %q to be omitted, got %s", banned, got)
		}
	}
}

// --- resolveSavePath ---

func TestResolveSavePath_EmptyUserPath(t *testing.T) {
	got, err := resolveSavePath("/data/transcripts", "", "abc-123", "json")
	if err != nil {
		t.Fatal(err)
	}
	if got != "/data/transcripts/abc-123.json" {
		t.Errorf("got %q", got)
	}
}

func TestResolveSavePath_RelativeJoinsSaveDir(t *testing.T) {
	got, err := resolveSavePath("/data/transcripts", "subdir/lecture.json", "abc-123", "json")
	if err != nil {
		t.Fatal(err)
	}
	if got != "/data/transcripts/subdir/lecture.json" {
		t.Errorf("got %q", got)
	}
}

func TestResolveSavePath_AbsoluteUsedAsIs(t *testing.T) {
	got, err := resolveSavePath("/data/transcripts", "/tmp/explicit.json", "abc-123", "json")
	if err != nil {
		t.Fatal(err)
	}
	if got != "/tmp/explicit.json" {
		t.Errorf("got %q", got)
	}
}

func TestResolveSavePath_DirGetsAutoFilename(t *testing.T) {
	dir := t.TempDir()
	got, err := resolveSavePath("/whatever", dir, "abc-123", "txt")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, "abc-123.txt")
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

// Compile-time check that JobClient is satisfied by *client.Client.
var _ JobClient = (*client.Client)(nil)

// Compile-time check that mock satisfies JobClient.
var _ JobClient = (*mockClient)(nil)
