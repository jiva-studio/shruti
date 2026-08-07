// Package ask turns a question written in words into the filter a search runs
// on, and hands both back.
//
// "лекции Шиварамы Свами за 2012 год о карме" is a speaker, a period and a
// topic. Somebody has to read that into fields, and the caller has to get those
// fields back — otherwise dropping the year means rewriting the sentence and
// hoping it is read the same way twice.
//
// So the filter is one model, in and out. It is what a caller sends, what comes
// back enriched, and what they send again with one field changed. That is the
// difference between a search box and a search a person can steer.
//
// This package decides what to search for. It does not search: that is
// application/search, which knows SQL and ranking and nothing about models.
package ask

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/search"
)

// Filter is the question as fields. Every one is optional, and empty means "do
// not narrow by this" rather than "match empty".
type Filter struct {
	Text   string `json:"text,omitempty"`
	Author string `json:"author,omitempty"`
	// Language is a two-letter code. Nothing infers it from the words of the
	// question: a Russian question finding an English lecture on the same talk
	// is wanted, and filtering by the language of the asking would prevent it.
	Language string `json:"language,omitempty"`
	Source   string `json:"source,omitempty"`
	// Ref is a scripture reference as a person writes it — "BG 2.13". The
	// corpus holds both halves separately.
	Ref        string     `json:"ref,omitempty"`
	Collection string     `json:"collection,omitempty"`
	DateFrom   *time.Time `json:"date_from,omitempty"`
	DateTo     *time.Time `json:"date_to,omitempty"`
	Limit      int        `json:"limit,omitempty"`
	Offset     int        `json:"offset,omitempty"`
}

// Message is anything that happened to the question and is not a recording: a
// field the sentence overruled, a name that matches nobody, a reader that was
// not configured.
//
// One list rather than several, because a caller wants one place to look, and
// each carries the field it is about so an interface can put it there.
type Message struct {
	Field string `json:"field,omitempty"`
	Kind  string `json:"kind"`
	Text  string `json:"text"`
}

// The kinds a message can be. Named so a caller can act on them without
// reading English.
const (
	// KindOverruled: the sentence said something the filter also said, and the
	// sentence won.
	KindOverruled = "overruled"
	// KindMatchesNobody: a filter was applied and nothing in the corpus can
	// satisfy it. The result is empty because of the question, not because of
	// the corpus.
	KindMatchesNobody = "matches_nobody"
	// KindNotRead: there was a sentence and nothing read it.
	KindNotRead = "not_read"
)

// Reader turns a sentence into a filter.
//
// now is passed in rather than read, so "за прошлый год" is answerable and one
// sentence always reads the same way — a reading that changes with the clock
// cannot be tested and cannot be explained.
type Reader interface {
	Read(ctx context.Context, question string, now time.Time) (Filter, error)
}

// Searcher is the search this package steers, narrowed to what it uses.
type Searcher interface {
	Search(ctx context.Context, q search.Query) ([]search.Hit, error)
	// Names reports whether an author filter can match anybody, so an empty
	// result can say which of the two empties it is.
	Names(ctx context.Context, author string) (bool, error)
}

// Service answers a question.
type Service struct {
	// Reader is optional. Without one a question is still a search: it becomes
	// the text, and a message says it was not read.
	Reader   Reader
	Searcher Searcher
	Now      func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

// Answer is what a question produces.
type Answer struct {
	// Question comes back exactly as it was asked. Nothing is stripped out of
	// it and it is not rewritten: it is the caller's, not ours.
	Question string       `json:"query"`
	Filter   Filter       `json:"filter"`
	Messages []Message    `json:"messages,omitempty"`
	Hits     []search.Hit `json:"hits"`
}

// Ask reads the question, folds it into the filter, and searches.
func (s *Service) Ask(ctx context.Context, question string, given Filter) (*Answer, error) {
	if s.Searcher == nil {
		return nil, fmt.Errorf("ask: no search configured")
	}
	out := &Answer{Question: question, Filter: given, Hits: []search.Hit{}}
	question = strings.TrimSpace(question)

	switch {
	case question == "":
		// Only a filter: this is the plain search, in a body.
	case s.Reader == nil:
		out.Filter.Text = firstNonEmpty(out.Filter.Text, question)
		out.Messages = append(out.Messages, Message{
			Kind: KindNotRead,
			Text: "no reader is configured, so the question was searched as written",
		})
	default:
		read, err := s.Reader.Read(ctx, question, s.now())
		if err != nil {
			// A reading that failed is not a search that failed. The words are
			// still words, and somebody is waiting.
			out.Filter.Text = firstNonEmpty(out.Filter.Text, question)
			out.Messages = append(out.Messages, Message{
				Kind: KindNotRead,
				Text: "the question could not be read (" + err.Error() + "), so it was searched as written",
			})
			break
		}
		out.Filter, out.Messages = fold(given, read, out.Messages)
		// The question itself is what is searched for. Cutting the speaker's
		// name out of it would be second-guessing: a lecture that names them is
		// a reasonable thing to find, and the author filter already narrows.
		out.Filter.Text = firstNonEmpty(out.Filter.Text, question)
	}

	q := out.Filter.query()
	if out.Filter.Author != "" {
		known, err := s.Searcher.Names(ctx, out.Filter.Author)
		if err != nil {
			return nil, err
		}
		if !known {
			// The filter stays and the answer is empty. Widening somebody's
			// search without being asked is not this service's decision — but
			// an empty list that cannot say why is indistinguishable from a
			// corpus that holds nothing, and those are different answers.
			out.Messages = append(out.Messages, Message{
				Field: "author", Kind: KindMatchesNobody,
				Text: fmt.Sprintf("no speaker named %q is in the corpus", out.Filter.Author),
			})
			return out, nil
		}
	}

	hits, err := s.Searcher.Search(ctx, q)
	if err != nil {
		return nil, err
	}
	if hits != nil {
		out.Hits = hits
	}
	return out, nil
}

// fold puts what was read over what was given.
//
// The sentence wins. A filter is what the caller set last time; the sentence is
// what they are saying now. Every field it overrules is reported, so an
// interface can say "year changed to 2012" without diffing anything itself.
func fold(given, read Filter, msgs []Message) (Filter, []Message) {
	out := given
	note := func(field, was, now string) {
		if now == "" {
			return
		}
		if was != "" && was != now {
			msgs = append(msgs, Message{
				Field: field, Kind: KindOverruled,
				Text: fmt.Sprintf("the question said %q; the filter said %q", now, was),
			})
		}
	}

	note("author", given.Author, read.Author)
	note("language", given.Language, read.Language)
	note("source", given.Source, read.Source)
	note("ref", given.Ref, read.Ref)
	note("collection", given.Collection, read.Collection)
	note("date_from", dateText(given.DateFrom), dateText(read.DateFrom))
	note("date_to", dateText(given.DateTo), dateText(read.DateTo))

	out.Author = firstNonEmpty(read.Author, given.Author)
	out.Language = firstNonEmpty(read.Language, given.Language)
	out.Source = firstNonEmpty(read.Source, given.Source)
	out.Ref = firstNonEmpty(read.Ref, given.Ref)
	out.Collection = firstNonEmpty(read.Collection, given.Collection)
	if read.DateFrom != nil {
		out.DateFrom = read.DateFrom
	}
	if read.DateTo != nil {
		out.DateTo = read.DateTo
	}
	return out, msgs
}

// query is the filter as the search understands it.
func (f Filter) query() search.Query {
	q := search.Query{
		Text:       f.Text,
		Author:     f.Author,
		Language:   f.Language,
		Source:     f.Source,
		Collection: f.Collection,
		DateFrom:   f.DateFrom,
		DateTo:     f.DateTo,
		Limit:      f.Limit,
		Offset:     f.Offset,
	}
	// "BG 2.13" is how a person writes it; the columns hold the two halves
	// apart.
	if parts := strings.Fields(f.Ref); len(parts) == 2 {
		q.RefSource, q.RefTokens = parts[0], parts[1]
	}
	return q
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func dateText(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format("2006-01-02")
}
