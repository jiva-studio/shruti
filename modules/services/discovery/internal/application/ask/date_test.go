package ask_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/application/ask"
)

// A period ticked in an interface is a day, and a day is what has to decode.
// It did not: time.Time reads RFC3339 and nothing else, so one date facet
// failed the whole body and answered 400 to a question that had nothing wrong
// with it.
func TestAFilterDecodesADay(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want *time.Time
		fail bool
	}{
		{name: "a day", body: `{"date_from":"2019-01-01"}`, want: at(2019, 1, 1)},
		// RFC3339 stays readable: it is what this endpoint used to be the only
		// reader of, and a caller echoing an older filter back must still work.
		{name: "rfc3339", body: `{"date_from":"2019-01-01T00:00:00Z"}`, want: at(2019, 1, 1)},
		{name: "cleared", body: `{"date_from":""}`},
		{name: "null", body: `{"date_from":null}`},
		{name: "absent", body: `{}`},
		{name: "a year", body: `{"date_from":"2019"}`, fail: true},
		{name: "written the other way round", body: `{"date_from":"01.01.2019"}`, fail: true},
		{name: "no month like that", body: `{"date_from":"2019-13-45"}`, fail: true},
		{name: "not a date at all", body: `{"date_from":"soon"}`, fail: true},
		{name: "not even a string", body: `{"date_from":2019}`, fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var f ask.Filter
			err := json.Unmarshal([]byte(tc.body), &f)
			if tc.fail {
				if err == nil {
					t.Fatalf("%s decoded to %v, want an error", tc.body, f.DateFrom)
				}
				return
			}
			if err != nil {
				t.Fatalf("%s: %v", tc.body, err)
			}
			switch {
			case tc.want == nil:
				// A cleared date narrows nothing, and a filter holding only
				// that one is empty — otherwise a request carrying nothing
				// would be answered with the whole corpus.
				if !f.Empty() {
					t.Errorf("%s narrows something: %+v", tc.body, f)
				}
			case f.DateFrom == nil || !f.DateFrom.Equal(*tc.want):
				t.Errorf("%s -> %v, want %v", tc.body, f.DateFrom, *tc.want)
			case f.Empty():
				t.Errorf("%s says it narrows nothing", tc.body)
			}
		})
	}
}

// What comes back is what can be sent again. The filter round-trips by design —
// that is how dropping a year works without rewriting the question — so it has
// to answer in the shape the caller writes.
func TestADayComesBackAsADay(t *testing.T) {
	b, err := json.Marshal(ask.Filter{DateFrom: day("2019-01-01")})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(b), `{"date_from":"2019-01-01"}`; got != want {
		t.Errorf("= %s, want %s", got, want)
	}
	// And an unset one is not written at all.
	if b, err = json.Marshal(ask.Filter{Text: "карма"}); err != nil {
		t.Fatal(err)
	} else if string(b) != `{"text":"карма"}` {
		t.Errorf("= %s", b)
	}
}

func at(y int, m time.Month, d int) *time.Time {
	t := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	return &t
}
