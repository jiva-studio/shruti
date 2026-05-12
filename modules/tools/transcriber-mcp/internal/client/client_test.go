package client

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestServer(t *testing.T, h http.Handler) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return New(srv.URL)
}

func TestGetHealth_OK(t *testing.T) {
	c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(Health{Workers: 2, Queued: 1, ModelLoaded: true})
	}))
	h, err := c.GetHealth(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if h.Workers != 2 || h.Queued != 1 || !h.ModelLoaded {
		t.Errorf("got %+v", h)
	}
}

func TestGetJob_OK(t *testing.T) {
	c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/jobs/abc" {
			t.Fatalf("path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(Job{
			JobID: "abc", Status: StatusDone, Confidence: 0.95, DurationSeconds: 100,
		})
	}))
	j, err := c.GetJob(context.Background(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if j.JobID != "abc" || j.Status != StatusDone || j.Confidence != 0.95 {
		t.Errorf("got %+v", j)
	}
}

func TestGetJob_NotFound(t *testing.T) {
	c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"job not found"}`, http.StatusNotFound)
	}))
	_, err := c.GetJob(context.Background(), "missing")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestListJobs_FilterAndLimit(t *testing.T) {
	var seenURL string
	c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenURL = r.URL.RequestURI()
		_ = json.NewEncoder(w).Encode([]Job{{JobID: "a"}, {JobID: "b"}})
	}))
	jobs, err := c.ListJobs(context.Background(), "done", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 {
		t.Errorf("got %d jobs", len(jobs))
	}
	if !strings.Contains(seenURL, "status=done") || !strings.Contains(seenURL, "limit=25") {
		t.Errorf("query missing filters: %s", seenURL)
	}
}

func TestGetTranscript_Conflict(t *testing.T) {
	c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"transcript not ready (status=running)"}`, http.StatusConflict)
	}))
	_, err := c.GetTranscript(context.Background(), "abc")
	if !errors.Is(err, ErrConflict) {
		t.Errorf("expected ErrConflict, got %v", err)
	}
}

func TestGetTranscript_OK(t *testing.T) {
	c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(Transcript{
			Text:        "hello world",
			WordTimings: []WordTiming{{Word: "hello", StartTime: 0, EndTime: 1, Confidence: 1}},
		})
	}))
	tr, err := c.GetTranscript(context.Background(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Text != "hello world" || len(tr.WordTimings) != 1 {
		t.Errorf("got %+v", tr)
	}
}

func TestDeleteJob(t *testing.T) {
	cases := []struct {
		status int
		want   error
	}{
		{http.StatusNoContent, nil},
		{http.StatusNotFound, ErrNotFound},
		{http.StatusConflict, ErrConflict},
	}
	for _, tc := range cases {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodDelete {
					t.Fatalf("method: %s", r.Method)
				}
				w.WriteHeader(tc.status)
			}))
			err := c.DeleteJob(context.Background(), "abc")
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v want %v", err, tc.want)
			}
		})
	}
}

func TestServerErrorPropagates(t *testing.T) {
	c := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	_, err := c.GetJob(context.Background(), "x")
	if err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Errorf("expected HTTP 500 wrapper, got %v", err)
	}
}
