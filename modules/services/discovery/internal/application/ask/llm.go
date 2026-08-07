package ask

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/pipeline/openaicompat"
)

//go:embed prompts/system.txt
var systemPrompt string

//go:embed prompts/user.txt
var userPrompt string

// readTimeout is short on purpose. A person is waiting: this is not the crawl,
// where a slow provider costs nothing but time nobody is counting. A reading
// that has not arrived by now is worth less than the results.
//
// Three seconds and a second try, rather than six seconds and none. The model
// answers in about a second when it is asked of the quicker upstream, so a
// reading still outstanding at three has met the slow one — and asking again
// gets a fresh routing decision, which beats waiting out the one already lost.
const (
	readTimeout = 3 * time.Second
	readTries   = 2
)

// routing asks the gateway for the quickest upstream it has. One model is
// served by several, and they are not equally quick: measured over twenty calls
// of the same request, one answered every time inside 1.1s and the other took
// up to 4.7s — and every slow call in a day of use was the second one. The
// preference is a sort rather than a named vendor, because a name is a thing
// that changes and a preference is not.
var routing = json.RawMessage(`{"sort":"latency","allow_fallbacks":true}`)

// LLM reads a question through an OpenAI-compatible endpoint.
type LLM struct {
	client *openaicompat.Client
	model  string
}

type LLMOptions struct {
	Endpoint string
	APIKey   string
	Model    string
}

func NewLLM(opts LLMOptions) (*LLM, error) {
	client, err := openaicompat.New(openaicompat.Options{
		Endpoint: opts.Endpoint,
		APIKey:   opts.APIKey,
	})
	if err != nil {
		return nil, err
	}
	return &LLM{client: client, model: opts.Model}, nil
}

// reply is what the model is asked for. Dates arrive as text because a model
// writes dates as text.
type reply struct {
	Author     string `json:"author"`
	Language   string `json:"language"`
	Source     string `json:"source"`
	Ref        string `json:"ref"`
	Collection string `json:"collection"`
	DateFrom   string `json:"date_from"`
	DateTo     string `json:"date_to"`
}

func (l *LLM) Read(ctx context.Context, question string, now time.Time) (Filter, error) {
	user := strings.NewReplacer(
		"__TODAY__", now.Format("2006-01-02"),
		"__QUESTION__", question,
	).Replace(userPrompt)

	var last error
	for try := range readTries {
		attempt, cancel := context.WithTimeout(ctx, readTimeout)
		var got reply
		_, err := l.client.RunJSON(attempt, openaicompat.Call{
			Model:     l.model,
			MaxTokens: 400,
			System:    systemPrompt,
			User:      user,
			Reasoning: openaicompat.ReasoningOff,
			Provider:  routing,
		}, &got)
		cancel()
		if err == nil {
			return got.filter(), nil
		}
		last = err
		// The caller gave up, or is about to. Trying again would only make
		// somebody wait for an answer they will not be shown.
		if ctx.Err() != nil {
			break
		}
		_ = try
	}
	return Filter{}, fmt.Errorf("ask: %w", last)
}

func (r reply) filter() Filter {
	f := Filter{
		Collection: strings.TrimSpace(r.Collection),
		DateFrom:   date(r.DateFrom),
		DateTo:     date(r.DateTo),
	}
	// The model names one speaker; the filter holds a list, because a person
	// choosing in an interface ticks several.
	if name := strings.TrimSpace(r.Author); name != "" {
		f.Authors = []string{name}
	}
	// A language is a two-letter code or it is nothing. "Russian" is the model
	// describing rather than answering, and the same check guards the write
	// path for the same reason.
	if len(r.Language) == 2 {
		f.Languages = []string{strings.ToLower(r.Language)}
	}
	// The reference is checked against the books the corpus can address. A
	// model that invents one costs the asker every result, and a reference to
	// a book nobody holds is worse than no reference at all.
	if parts := strings.Fields(strings.TrimSpace(r.Ref)); len(parts) == 2 && domain.Addressable(parts[0]) {
		if expanded, _ := domain.ExpandRefs(parts[0], parts[1]); len(expanded) > 0 {
			f.Ref = expanded[0].Source + " " + expanded[0].Tokens
		}
	}
	return f
}

func date(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil
	}
	return &t
}
