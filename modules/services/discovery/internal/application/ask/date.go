package ask

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// DateLayout is a day as everything that talks to this service writes one:
// "2019-01-01". A period is picked in an interface by year or by month, and
// what that produces is a day, not an instant.
const DateLayout = "2006-01-02"

// Date is one end of that period.
//
// It exists because time.Time decodes from RFC3339 and nothing else, so a
// filter carrying "2019-01-01" failed the whole body and took the question
// down with it — a year ticked in the interface answered 400, not "no dates".
// The layout lives here, once, and the query string beside it reads days the
// same way.
type Date struct {
	time.Time
}

// ParseDate reads a day.
//
// RFC3339 is accepted as well, and deliberately: it is what this endpoint used
// to be the only reader of, and what its own answers used to carry, so a caller
// echoing an older filter back — which is the whole point of a filter that
// comes back enriched — must keep working. The two shapes cannot be confused
// for one another, so accepting both costs nothing.
//
// An empty string is not a date and not an error: it is the absence of a bound,
// which is what an interface sends when the period was cleared.
func ParseDate(s string) (Date, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Date{}, nil
	}
	if t, err := time.Parse(DateLayout, s); err == nil {
		return Date{t}, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return Date{t}, nil
	}
	return Date{}, fmt.Errorf("date %q is not a day (%s)", s, DateLayout)
}

func (d *Date) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*d = Date{}
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("date: want a day as a string (%s)", DateLayout)
	}
	got, err := ParseDate(s)
	if err != nil {
		return err
	}
	*d = got
	return nil
}

// MarshalJSON answers in the shape the caller sent, so the filter that comes
// back is one it can send again unchanged.
func (d Date) MarshalJSON() ([]byte, error) {
	if d.IsZero() {
		return []byte("null"), nil
	}
	return json.Marshal(d.Format(DateLayout))
}

// set reports whether this end of the period narrows anything. A cleared date
// arrives as a present key with nothing in it, so "not nil" is not the same
// question.
func (d *Date) set() bool {
	return d != nil && !d.Time.IsZero()
}

// time is the day as the search takes it.
func (d *Date) time() *time.Time {
	if !d.set() {
		return nil
	}
	t := d.Time
	return &t
}
