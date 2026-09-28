package pull_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/application/pull"
	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
)

// feed is a change log of n rows with global_seq 1..n. It records the limit
// it was asked for.
type feed struct {
	n         int64
	err       error
	gotLimit  int
	gotCursor int64
}

func (f *feed) Since(_ context.Context, _ uuid.UUID, cursor int64, limit int) ([]changes.Change, error) {
	f.gotLimit, f.gotCursor = limit, cursor
	if f.err != nil {
		return nil, f.err
	}
	var out []changes.Change
	for seq := cursor + 1; seq <= f.n && len(out) < limit; seq++ {
		out = append(out, changes.Change{ServerSeq: seq, Collection: "notes", DocID: "d", HLC: "h"})
	}
	return out, nil
}

func newPull(t *testing.T, f *feed, maxLimit int) *pull.UseCase {
	t.Helper()
	uc, err := pull.New(f, maxLimit)
	if err != nil {
		t.Fatal(err)
	}
	return uc
}

func TestNewRefusesBadArguments(t *testing.T) {
	if _, err := pull.New(nil, 10); err == nil {
		t.Error("nil feed accepted")
	}
	for _, limit := range []int{0, -1} {
		if _, err := pull.New(&feed{}, limit); err == nil {
			t.Errorf("max limit %d accepted", limit)
		}
	}
}

func TestPullClampsTheLimitToTheMaximum(t *testing.T) {
	cases := map[string]struct{ asked, want int }{
		"zero":          {0, 50},
		"negative":      {-3, 50},
		"above":         {51, 50},
		"at the max":    {50, 50},
		"below the max": {7, 7},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := &feed{}
			if _, err := newPull(t, f, 50).Pull(t.Context(), uuid.New(), pull.Request{Limit: tc.asked}); err != nil {
				t.Fatal(err)
			}
			if f.gotLimit != tc.want {
				t.Fatalf("feed asked for %d, want %d", f.gotLimit, tc.want)
			}
		})
	}
}

// A page that fills the limit may have more behind it; one that falls short
// is the end.
func TestPullReportsMoreWhenThePageFillsTheLimit(t *testing.T) {
	cases := map[string]struct {
		rows     int64
		limit    int
		maxLimit int
		hasMore  bool
	}{
		"page equals limit": {rows: 5, limit: 5, maxLimit: 50, hasMore: true},
		"more rows":         {rows: 9, limit: 5, maxLimit: 50, hasMore: true},
		"short page":        {rows: 4, limit: 5, maxLimit: 50, hasMore: false},
		// The page is measured against the clamped limit, not the asked one.
		"page equals clamped limit": {rows: 3, limit: 100, maxLimit: 3, hasMore: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			res, err := newPull(t, &feed{n: tc.rows}, tc.maxLimit).
				Pull(t.Context(), uuid.New(), pull.Request{Limit: tc.limit})
			if err != nil {
				t.Fatal(err)
			}
			if res.HasMore != tc.hasMore {
				t.Fatalf("HasMore = %v with %d rows at limit %d", res.HasMore, len(res.Changes), tc.limit)
			}
		})
	}
}

func TestPullAdvancesTheCursorToTheLastRow(t *testing.T) {
	f := &feed{n: 10}
	res, err := newPull(t, f, 100).Pull(t.Context(), uuid.New(), pull.Request{Cursor: 4, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if f.gotCursor != 4 {
		t.Fatalf("feed read from %d, want 4", f.gotCursor)
	}
	if len(res.Changes) != 3 || res.Changes[0].ServerSeq != 5 || res.Cursor != 7 {
		t.Fatalf("page = %d rows, first %d, cursor %d", len(res.Changes), res.Changes[0].ServerSeq, res.Cursor)
	}
}

func TestPullOfAnEmptyTailKeepsTheCursor(t *testing.T) {
	res, err := newPull(t, &feed{n: 3}, 100).Pull(t.Context(), uuid.New(), pull.Request{Cursor: 3, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if res.Changes == nil || len(res.Changes) != 0 || res.Cursor != 3 || res.HasMore {
		t.Fatalf("result = %+v", res)
	}
}

func TestPullPassesAFeedErrorOn(t *testing.T) {
	f := &feed{err: errors.New("db down")}
	if _, err := newPull(t, f, 10).Pull(t.Context(), uuid.New(), pull.Request{}); !errors.Is(err, f.err) {
		t.Fatalf("err = %v", err)
	}
}
