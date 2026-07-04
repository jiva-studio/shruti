// Package selector turns a campaign's dynamic filters into a single chosen
// Candidate. Filters compose: content kind picks the pool, then language /
// on-this-day / topic narrow it, not-posted-days drops recent repeats, and
// order+pick choose the winner.
package selector

import (
	"context"
	"fmt"
	"math/rand"
	"sort"
	"time"

	"github.com/jiva-studio/shruti-social-poster/internal/catalog"
	"github.com/jiva-studio/shruti-social-poster/internal/config"
	"github.com/jiva-studio/shruti-social-poster/internal/state"
)

type Selector struct {
	cat *catalog.Manager
	st  *state.State
	rng *rand.Rand
}

func New(cat *catalog.Manager, st *state.State) *Selector {
	return &Selector{cat: cat, st: st, rng: rand.New(rand.NewSource(time.Now().UnixNano()))}
}

// ErrNoCandidate means every filter passed but nothing was left to post.
var ErrNoCandidate = fmt.Errorf("no candidate matched the filters")

// Select resolves one Candidate for a campaign, or ErrNoCandidate.
func (s *Selector) Select(ctx context.Context, cp config.Campaign) (catalog.Candidate, error) {
	cat := s.cat.Region(cp.Region)
	if cat == nil {
		return catalog.Candidate{}, fmt.Errorf("no catalog for region %q", cp.Region)
	}

	monthDay := ""
	if cp.Filters.Day == "on_this_day" {
		monthDay = time.Now().Format("01-02")
	}

	var (
		pool []catalog.Candidate
		err  error
	)
	switch cp.Content {
	case config.ContentDailyWisdom:
		pool, err = cat.Wisdom(ctx, cp.Filters.Language, cp.Filters.Topic)
	case config.ContentLecture:
		pool, err = cat.Lectures(ctx, cp.Filters.Language, monthDay, cp.Filters.Topic)
	default:
		return catalog.Candidate{}, fmt.Errorf("unknown content kind %q", cp.Content)
	}
	if err != nil {
		return catalog.Candidate{}, err
	}
	if len(pool) == 0 {
		return catalog.Candidate{}, ErrNoCandidate
	}

	// Drop content posted within the not-posted-days window.
	if cp.Filters.NotPostedDays > 0 {
		posted, err := s.st.PostedWithin(ctx, cp.Filters.NotPostedDays)
		if err != nil {
			return catalog.Candidate{}, err
		}
		pool = filterOut(pool, posted)
		if len(pool) == 0 {
			return catalog.Candidate{}, ErrNoCandidate
		}
	}

	s.order(pool, cp.Filters.Order)

	switch cp.Filters.Pick {
	case "", "random":
		if cp.Filters.Order == "" || cp.Filters.Order == "random" {
			return pool[s.rng.Intn(len(pool))], nil
		}
		// An explicit ordering + random pick means "pick within the top slice"
		// is overkill; honor the ordering by returning the head.
		return pool[0], nil
	case "top1":
		return pool[0], nil
	default:
		return catalog.Candidate{}, fmt.Errorf("unknown pick %q", cp.Filters.Pick)
	}
}

func (s *Selector) order(pool []catalog.Candidate, order string) {
	switch order {
	case "topic_weight", "trending":
		sort.SliceStable(pool, func(i, j int) bool { return pool[i].Weight > pool[j].Weight })
	case "recent":
		sort.SliceStable(pool, func(i, j int) bool { return pool[i].Date > pool[j].Date })
	case "", "random":
		s.rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	}
}

func filterOut(pool []catalog.Candidate, drop map[string]struct{}) []catalog.Candidate {
	out := pool[:0:0]
	for _, c := range pool {
		if _, skip := drop[c.ID]; !skip {
			out = append(out, c)
		}
	}
	return out
}
