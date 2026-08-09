package normalize

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"github.com/jiva-studio/lectorium/pipeline/openaicompat"
)

//go:embed prompts/system.txt
var systemPrompt string

//go:embed prompts/user.txt
var userPrompt string

// promptVersion is derived from the prompt text, so editing a prompt
// invalidates every stored input hash on its own — there is no version number
// anyone can forget to bump.
var promptVersion = func() string {
	sum := sha256.Sum256([]byte(systemPrompt + userPrompt))
	return hex.EncodeToString(sum[:4])
}()

// maxBatch is how many files go into one call. Beyond this the reply gets long
// enough that models start dropping entries.
const maxBatch = 40

// LLM normalizes through an OpenAI-compatible endpoint.
type LLM struct {
	client       *openaicompat.Client
	model        string
	maxTokens    int
	knownSources map[string]bool
	sourceList   string
	now          func() time.Time

	mu    sync.Mutex
	spent []Spend
}

// LLMOptions configures the live normalizer.
type LLMOptions struct {
	Endpoint    string
	APIKey      string
	Model       string
	MaxTokens   int
	SourceCodes []string
}

func NewLLM(opts LLMOptions) (*LLM, error) {
	client, err := openaicompat.New(openaicompat.Options{
		Endpoint: opts.Endpoint,
		APIKey:   opts.APIKey,
	})
	if err != nil {
		return nil, err
	}
	codes := opts.SourceCodes
	if len(codes) == 0 {
		codes = DefaultSourceCodes
	}
	if opts.MaxTokens <= 0 {
		opts.MaxTokens = 8000
	}
	return &LLM{
		client:       client,
		model:        opts.Model,
		maxTokens:    opts.MaxTokens,
		knownSources: SourceCodeSet(codes),
		sourceList:   strings.Join(codes, ", "),
		now:          time.Now,
	}, nil
}

// record keeps what a call cost until somebody asks. A call is charged whether
// or not its reply parsed, so this is written before the error is checked.
func (l *LLM) record(s Spend) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.spent = append(l.spent, s)
}

// Spent hands over what has been billed and forgets it.
func (l *LLM) Spent() []Spend {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.spent
	l.spent = nil
	return out
}

func (l *LLM) PromptVersion() string { return promptVersion }
func (l *LLM) Model() string         { return l.model }

// Normalize answers for every file in the batch, splitting into calls small
// enough that nothing gets dropped from the reply.
func (l *LLM) Normalize(ctx context.Context, batch Batch) ([]Result, error) {
	out := make([]Result, 0, len(batch.Items))
	for start := 0; start < len(batch.Items); start += maxBatch {
		end := min(start+maxBatch, len(batch.Items))
		part, err := l.ask(ctx, batch, batch.Items[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, part...)
	}
	return out, nil
}

// errTruncated is a reply that ran out of room before it finished.
var errTruncated = errors.New("normalize: reply was cut off")

// ask reads one group of files, halving the group when the reply comes back cut
// off. Asking again for the same group would not help: the same files make the
// same request, which runs out of room in the same place.
func (l *LLM) ask(ctx context.Context, batch Batch, items []Input) ([]Result, error) {
	part, err := l.normalizeOne(ctx, Batch{
		PageURL: batch.PageURL, PageTitle: batch.PageTitle, Items: items,
	})
	if !errors.Is(err, errTruncated) {
		return part, err
	}
	if len(items) == 1 {
		// One file whose answer alone does not fit is a file we cannot read.
		// It is left unread rather than left blocking its page.
		slog.WarnContext(ctx, "normalize_reply_too_long", "media_url", items[0].MediaURL)
		return []Result{{Unanswered: true}}, nil
	}
	mid := len(items) / 2
	left, err := l.ask(ctx, batch, items[:mid])
	if err != nil {
		return nil, err
	}
	right, err := l.ask(ctx, batch, items[mid:])
	if err != nil {
		return nil, err
	}
	return append(left, right...), nil
}

// promptItem is what the model is shown. The address itself is left out: the
// filename and the path segments carry the same information, and sending it
// would pay for the same long string twice — once going in and once coming
// back, where tokens cost six times as much.
type promptItem struct {
	N            int               `json:"n"`
	Filename     string            `json:"filename,omitempty"`
	PathSegments []string          `json:"path_segments,omitempty"`
	Tags         map[string]string `json:"tags,omitempty"`
	Material     []domain.Material `json:"material,omitempty"`
}

// reply is the model's answer. The index comes back so an answer can be matched
// to its file without trusting the order — two tokens where echoing the address
// cost forty.
type reply struct {
	Items []struct {
		N          int      `json:"n"`
		Title      string   `json:"title"`
		Authors    []string `json:"authors"`
		Location   string   `json:"location"`
		Date       string   `json:"date"`
		Language   string   `json:"language"`
		References []struct {
			Source string `json:"source"`
			Tokens string `json:"tokens"`
		} `json:"references"`
	} `json:"items"`
}

func (l *LLM) normalizeOne(ctx context.Context, batch Batch) ([]Result, error) {
	shown := make([]promptItem, len(batch.Items))
	for i, in := range batch.Items {
		shown[i] = promptItem{
			N:            i,
			Filename:     in.Filename,
			PathSegments: in.PathSegments,
			Tags:         in.Tags,
			Material:     in.Material,
		}
	}
	files, err := json.MarshalIndent(shown, "", "  ")
	if err != nil {
		return nil, err
	}
	user := strings.NewReplacer(
		"__KNOWN_SOURCES__", l.sourceList,
		"__FILES__", string(files),
	).Replace(userPrompt)

	var got reply
	res, err := l.client.RunJSON(ctx, openaicompat.Call{
		Model:     l.model,
		MaxTokens: l.maxTokens,
		System:    systemPrompt,
		User:      user,
		Reasoning: openaicompat.ReasoningOff,
	}, &got)
	l.record(Spend{
		Kind: "normalize", Model: l.model, Items: len(batch.Items),
		// A call always spends input tokens, so none reported means the
		// provider sent no usage rather than that the call was free.
		Reported: res.TokensIn > 0,
		TokensIn: res.TokensIn, TokensOut: res.TokensOut, CostUSD: res.CostUSD,
	})
	// Checked before the parse error, because a reply cut off mid-array fails
	// to parse and asking for it again would fail identically.
	if res.FinishReason == "length" {
		return nil, errTruncated
	}
	if err != nil {
		return nil, fmt.Errorf("normalize: %w", err)
	}

	byIndex := make(map[int]int, len(got.Items))
	for i, item := range got.Items {
		byIndex[item.N] = i
	}
	// The numbers are the only thing tying an answer to a file. A reply that did
	// not echo the ones it was given -- one that numbers from one moves every
	// answer onto the file before it -- is not an answer about these files, so
	// none of it is kept and the next visit asks again.
	if !echoesItsNumbers(byIndex, len(got.Items), len(batch.Items)) {
		slog.WarnContext(ctx, "normalize_numbering_off",
			"page_url", batch.PageURL, "asked", len(batch.Items), "answered", len(got.Items))
		unread := make([]Result, len(batch.Items))
		for i := range unread {
			unread[i] = Result{Unanswered: true}
		}
		return unread, nil
	}

	results := make([]Result, len(batch.Items))
	for i, in := range batch.Items {
		j, ok := byIndex[i]
		if !ok {
			slog.WarnContext(ctx, "normalize_no_answer", "media_url", in.MediaURL)
			results[i] = Result{Unanswered: true}
			continue
		}
		a := got.Items[j]
		r := Result{
			Title:    strings.TrimSpace(a.Title),
			Author:   firstName(a.Authors),
			Authors:  trimAll(a.Authors),
			Location: strings.TrimSpace(a.Location),
			Date:     strings.TrimSpace(a.Date),
			Language: strings.TrimSpace(a.Language),
		}
		// A range becomes one entry per verse in Validate, once the book it
		// names is known to exist — not here, where a book we cannot address
		// would be fanned out to fifty rows before anything checked it.
		for _, ref := range a.References {
			r.References = append(r.References, domain.Ref{Source: ref.Source, Tokens: ref.Tokens})
		}
		for _, note := range Validate(&r, l.knownSources, l.now()) {
			slog.WarnContext(ctx, "normalize_ref_dropped", "media_url", in.MediaURL, "reason", note)
		}
		results[i] = r
	}
	return results, nil
}

// firstName is the speaker written on the recording, for the many places that
// want one name. The rest are still linked; this is only what gets shown.
func firstName(names []string) string {
	for _, n := range names {
		if t := strings.TrimSpace(n); t != "" {
			return t
		}
	}
	return ""
}

func trimAll(names []string) []string {
	var out []string
	for _, n := range names {
		if t := strings.TrimSpace(n); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// echoesItsNumbers reports whether a reply accounted for every file it was
// given, once each, under the number it was given. Duplicates, gaps, extras and
// numbers outside the batch all mean the same thing: which answer belongs to
// which file is no longer known.
func echoesItsNumbers(byIndex map[int]int, answered, asked int) bool {
	if answered != asked || len(byIndex) != asked {
		return false
	}
	for i := range asked {
		if _, ok := byIndex[i]; !ok {
			return false
		}
	}
	return true
}
