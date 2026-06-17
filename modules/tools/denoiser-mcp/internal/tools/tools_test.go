package tools

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/denoiser-mcp/internal/client"
)

// --- mock JobClient ---

type mockClient struct {
	createFn      func(ctx context.Context, req client.CreateJobRequest) (*client.CreateJobResponse, error)
	createBatchFn func(ctx context.Context, req client.BatchRequest) (*client.BatchResponse, error)
	listObjectsFn func(ctx context.Context, req client.ListObjectsRequest) (*client.ListObjectsResponse, error)
	getJobFn      func(ctx context.Context, jobID string) (*client.Job, error)
	listJobsFn    func(ctx context.Context, status string, limit int) ([]*client.Job, error)
	deleteFn      func(ctx context.Context, jobID string) error
	getHealthFn   func(ctx context.Context) (*client.Health, error)
}

func (m *mockClient) CreateJob(ctx context.Context, req client.CreateJobRequest) (*client.CreateJobResponse, error) {
	return m.createFn(ctx, req)
}
func (m *mockClient) CreateBatch(ctx context.Context, req client.BatchRequest) (*client.BatchResponse, error) {
	return m.createBatchFn(ctx, req)
}
func (m *mockClient) ListObjects(ctx context.Context, req client.ListObjectsRequest) (*client.ListObjectsResponse, error) {
	return m.listObjectsFn(ctx, req)
}
func (m *mockClient) GetJob(ctx context.Context, id string) (*client.Job, error) {
	return m.getJobFn(ctx, id)
}
func (m *mockClient) ListJobs(ctx context.Context, s string, l int) ([]*client.Job, error) {
	return m.listJobsFn(ctx, s, l)
}
func (m *mockClient) DeleteJob(ctx context.Context, id string) error { return m.deleteFn(ctx, id) }
func (m *mockClient) GetHealth(ctx context.Context) (*client.Health, error) {
	if m.getHealthFn == nil {
		return nil, nil
	}
	return m.getHealthFn(ctx)
}

var fastCfg = Config{
	PollFast:    5 * time.Millisecond,
	PollSlow:    5 * time.Millisecond,
	PollFastFor: 100 * time.Millisecond,
	MaxTimeout:  3600 * time.Second,
}

func TestWaitForJob_DoneImmediately(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			return &client.Job{JobID: id, Status: client.StatusDone, DestURL: "https://x/clean.mp3",
				DurationSeconds: 600, ProcessingTimeSeconds: 55, RTFx: 10.9}, nil
		},
	}
	res, err := waitForJob(context.Background(), mc, "abc", 5*time.Second, fastCfg.withDefaults())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "done" || res.DestURL != "https://x/clean.mp3" || res.RTFx != 10.9 {
		t.Errorf("got %+v", res)
	}
	if res.TimedOut {
		t.Error("should not be timed out")
	}
}

func TestWaitForJob_Failed(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			return &client.Job{JobID: id, Status: client.StatusFailed, Error: "boom"}, nil
		},
	}
	res, err := waitForJob(context.Background(), mc, "abc", 5*time.Second, fastCfg.withDefaults())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "failed" || res.Error != "boom" {
		t.Errorf("got %+v", res)
	}
}

func TestWaitForJob_TransitionsThenTimesOut(t *testing.T) {
	calls := 0
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			calls++
			return &client.Job{JobID: id, Status: client.StatusRunning}, nil
		},
	}
	res, err := waitForJob(context.Background(), mc, "abc", 50*time.Millisecond, fastCfg.withDefaults())
	if err != nil {
		t.Fatal(err)
	}
	if !res.TimedOut {
		t.Errorf("expected timeout, got %+v", res)
	}
	if calls < 2 {
		t.Errorf("expected polling, got %d calls", calls)
	}
}

func TestWaitForJob_GetError(t *testing.T) {
	mc := &mockClient{
		getJobFn: func(ctx context.Context, id string) (*client.Job, error) {
			return nil, errors.New("network down")
		},
	}
	if _, err := waitForJob(context.Background(), mc, "abc", time.Second, fastCfg.withDefaults()); err == nil {
		t.Error("expected error")
	}
}

func TestMaskKey(t *testing.T) {
	cases := map[string]string{"": "", "abc": "****", "AKIAEXAMPLE": "AKIA*******"}
	for in, want := range cases {
		if got := maskKey(in); got != want {
			t.Errorf("maskKey(%q)=%q want %q", in, got, want)
		}
	}
}

func TestApplyPlanJSON(t *testing.T) {
	var p client.DenoiseParams
	pj := `{"segments":[
		{"start_ms":0,"end_ms":275000,"strategy":"afftdn","nr":8},
		{"start_ms":275000,"strategy":"deepfilternet"}
	],"crossfade_ms":150}`
	if err := applyPlanJSON(&p, pj); err != nil {
		t.Fatal(err)
	}
	if len(p.Segments) != 2 {
		t.Fatalf("want 2 segments, got %d", len(p.Segments))
	}
	s0 := p.Segments[0]
	if s0.StartMs != 0 || s0.EndMs == nil || *s0.EndMs != 275000 || s0.Strategy != "afftdn" || s0.NR == nil || *s0.NR != 8 {
		t.Errorf("segment0 = %+v", s0)
	}
	if s1 := p.Segments[1]; s1.EndMs != nil || s1.Strategy != "deepfilternet" {
		t.Errorf("segment1 should be open-ended deepfilternet, got %+v", s1)
	}
	if p.CrossfadeMs != 150 {
		t.Errorf("crossfade = %d, want 150", p.CrossfadeMs)
	}
}

func TestApplyPlanJSON_DefaultsAndErrors(t *testing.T) {
	var p client.DenoiseParams
	if err := applyPlanJSON(&p, `{"segments":[{"start_ms":0,"strategy":"afftdn"}]}`); err != nil {
		t.Fatal(err)
	}
	if p.CrossfadeMs != 120 {
		t.Errorf("default crossfade = %d, want 120", p.CrossfadeMs)
	}
	if err := applyPlanJSON(&p, `{"segments":[]}`); err == nil {
		t.Error("empty segments should error")
	}
	if err := applyPlanJSON(&p, `not json`); err == nil {
		t.Error("malformed json should error")
	}
}
