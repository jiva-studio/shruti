package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/orchestrator/internal/application/runingest"
	"github.com/jiva-studio/shruti/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/shruti/orchestrator/internal/domain/job"
)

type fakeSubmit struct {
	res    runingest.SubmitResult
	err    error
	gotReq ingest.Request
}

func (f *fakeSubmit) Submit(_ context.Context, req ingest.Request) (runingest.SubmitResult, error) {
	f.gotReq = req
	return f.res, f.err
}

type fakeJobs struct {
	j   *job.Job
	err error
}

func (f *fakeJobs) Get(_ context.Context, _ string) (*job.Job, error) { return f.j, f.err }

type fakeVerifier struct {
	userID string
	pro    bool
	err    error
}

func (f *fakeVerifier) VerifyPro(string) (string, bool, error) { return f.userID, f.pro, f.err }

func do(h http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func TestCreate_OK(t *testing.T) {
	sub := &fakeSubmit{res: runingest.SubmitResult{JobID: "job-1", State: job.StateQueued}}
	h := NewRouter(RouterDeps{Submitter: sub, Jobs: &fakeJobs{}, Verifier: &fakeVerifier{}})
	rec := do(h, http.MethodPost, "/ingest", "tok", `{"url":"https://x/y","title":"A talk","author":"BVP"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["job_id"] != "job-1" || got["state"] != "queued" {
		t.Fatalf("body = %v", got)
	}
	// The URL and hints reach Submit; the bearer token is threaded as the JWT.
	if sub.gotReq.URL != "https://x/y" || sub.gotReq.Title != "A talk" || sub.gotReq.Author != "BVP" || sub.gotReq.Token != "tok" {
		t.Fatalf("submit req = %+v", sub.gotReq)
	}
}

func TestCreate_MissingToken(t *testing.T) {
	h := NewRouter(RouterDeps{Submitter: &fakeSubmit{}, Jobs: &fakeJobs{}, Verifier: &fakeVerifier{}})
	if rec := do(h, http.MethodPost, "/ingest", "", `{"url":"https://x/y"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestCreate_NoURL(t *testing.T) {
	h := NewRouter(RouterDeps{Submitter: &fakeSubmit{}, Jobs: &fakeJobs{}, Verifier: &fakeVerifier{}})
	if rec := do(h, http.MethodPost, "/ingest", "tok", `{"title":"no url"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCreate_NotPro(t *testing.T) {
	h := NewRouter(RouterDeps{Submitter: &fakeSubmit{err: runingest.ErrNotPro}, Jobs: &fakeJobs{}, Verifier: &fakeVerifier{}})
	if rec := do(h, http.MethodPost, "/ingest", "tok", `{"url":"https://x/y"}`); rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", rec.Code)
	}
}

func TestCreate_NotConfigured(t *testing.T) {
	h := NewRouter(RouterDeps{}) // no submitter
	if rec := do(h, http.MethodPost, "/ingest", "tok", `{"url":"https://x/y"}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestStatus_OwnerOK(t *testing.T) {
	j := &job.Job{ID: "job-1", OwnerID: "user-1", State: job.StateRunning, Attempts: 1}
	h := NewRouter(RouterDeps{Submitter: &fakeSubmit{}, Jobs: &fakeJobs{j: j}, Verifier: &fakeVerifier{userID: "user-1"}})
	rec := do(h, http.MethodGet, "/ingest/job-1", "tok", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got runingest.JobStatus
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.State != "processing" || got.Attempts != 1 {
		t.Fatalf("status body = %+v (want processing)", got)
	}
}

func TestStatus_NotOwner_Is404(t *testing.T) {
	j := &job.Job{ID: "job-1", OwnerID: "someone-else", State: job.StateRunning}
	h := NewRouter(RouterDeps{Submitter: &fakeSubmit{}, Jobs: &fakeJobs{j: j}, Verifier: &fakeVerifier{userID: "user-1"}})
	if rec := do(h, http.MethodGet, "/ingest/job-1", "tok", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (must not leak another user's job)", rec.Code)
	}
}

func TestStatus_Missing_Is404(t *testing.T) {
	h := NewRouter(RouterDeps{Submitter: &fakeSubmit{}, Jobs: &fakeJobs{j: nil}, Verifier: &fakeVerifier{userID: "user-1"}})
	if rec := do(h, http.MethodGet, "/ingest/nope", "tok", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestStatus_MissingToken(t *testing.T) {
	h := NewRouter(RouterDeps{Submitter: &fakeSubmit{}, Jobs: &fakeJobs{}, Verifier: &fakeVerifier{}})
	if rec := do(h, http.MethodGet, "/ingest/job-1", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
