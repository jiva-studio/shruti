package handler_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/ask"
	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/handler"
	"github.com/jiva-studio/shruti/discovery/internal/metrics"
)

// stubSearcher answers everything with one hit and keeps the query it was
// handed, so a test can say what reached the search rather than what the body
// looked like.
type stubSearcher struct{ got search.Query }

func (s *stubSearcher) Search(_ context.Context, q search.Query) ([]search.Hit, error) {
	s.got = q
	return []search.Hit{{ItemID: 1, Title: "Talk"}}, nil
}

func (s *stubSearcher) Names(context.Context, string) (bool, error) { return true, nil }

func (s *stubSearcher) SpeakersNamed(context.Context, []string, []string) ([]search.Speaker, error) {
	return nil, nil
}

// searchRouter is the one route this file is about. It needs no database:
// /discovery/search is wired before the repo is, because the search service is
// what answers it.
func searchRouter(t *testing.T, s *stubSearcher) http.Handler {
	t.Helper()
	return handler.NewRouter(handler.RouterDeps{
		Ask:      &ask.Service{Searcher: s},
		Metrics:  metrics.New(time.Now().UTC()),
		Verifier: testVerifier(t),
	})
}

// The client sends a day, because a year ticked in an interface is a day. It
// used to fail the whole body decode and answer 400 — not "the date was
// ignored", but no search at all.
func TestAYearFacetIsAnswered(t *testing.T) {
	s := &stubSearcher{}
	code, body := do(t, searchRouter(t, s), http.MethodPost, "/discovery/search",
		`{"filter":{"date_from":"2019-01-01","date_to":"2019-12-31"}}`)
	if code != http.StatusOK {
		t.Fatalf("search = %d %v", code, body)
	}
	if s.got.DateFrom == nil || s.got.DateFrom.Year() != 2019 || s.got.DateTo == nil {
		t.Fatalf("the search was handed %v..%v", s.got.DateFrom, s.got.DateTo)
	}
	// And it comes back the way it was sent, so the next request is this one
	// with a field changed.
	filter, _ := body["filter"].(map[string]any)
	if filter["date_from"] != "2019-01-01" || filter["date_to"] != "2019-12-31" {
		t.Errorf("the filter came back as %v", filter)
	}
}

// A date nobody can read is still a bad request — the point is that a good one
// stops being treated like one.
func TestADateNobodyCanReadIsRefused(t *testing.T) {
	code, _ := do(t, searchRouter(t, &stubSearcher{}), http.MethodPost, "/discovery/search",
		`{"filter":{"date_from":"01.01.2019"}}`)
	if code != http.StatusBadRequest {
		t.Errorf("search = %d, want 400", code)
	}
}
