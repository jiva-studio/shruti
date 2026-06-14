package tools

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/akdasa-studios/shruti/modules/tools/denoiser-mcp/internal/client"
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
