package normalize

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/pipeline/openaicompat"
)

//go:embed prompts/system.txt
var systemPrompt string

//go:embed prompts/user.txt
var userPrompt string

//go:embed prompts/series.txt
var seriesPrompt string

// maxSeriesLinks bounds what one series call is shown. A page carrying more
// links than this is a catalogue, and the answer we want from it is "no".
const maxSeriesLinks = 200

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

func (l *LLM) PromptVersion() string { return promptVersion }
func (l *LLM) Model() string         { return l.model }

// Normalize answers for every file in the batch, splitting into calls small
// enough that nothing gets dropped from the reply.
func (l *LLM) Normalize(ctx context.Context, batch Batch) ([]Result, error) {
	out := make([]Result, 0, len(batch.Items))
	for start := 0; start < len(batch.Items); start += maxBatch {
		end := min(start+maxBatch, len(batch.Items))
		part, err := l.normalizeOne(ctx, Batch{
			PageURL:   batch.PageURL,
			PageTitle: batch.PageTitle,
			Items:     batch.Items[start:end],
		})
		if err != nil {
			return nil, err
		}
		out = append(out, part...)
	}
	return out, nil
}

// promptItem is what the model is shown. The address itself is left out: the
// filename and the path segments carry the same information, and sending it
// would pay for the same long string twice — once going in and once coming
// back, where tokens cost six times as much.
type promptItem struct {
	N            int               `json:"n"`
	Filename     string            `json:"filename,omitempty"`
	PathSegments []string          `json:"path_segments,omitempty"`
	Context      string            `json:"context,omitempty"`
	Tags         map[string]string `json:"tags,omitempty"`
}

// reply is the model's answer. The index comes back so an answer can be matched
// to its file without trusting the order — two tokens where echoing the address
// cost forty.
type reply struct {
	Items []struct {
		N          int    `json:"n"`
		Title      string `json:"title"`
		Author     string `json:"author"`
		Location   string `json:"location"`
		Date       string `json:"date"`
		Language   string `json:"language"`
		DurationS  int    `json:"duration_s"`
		References []struct {
			Source string `json:"source"`
			Tokens string `json:"tokens"`
		} `json:"references"`
		CollectionTitle string `json:"collection_title"`
	} `json:"items"`
}

func (l *LLM) normalizeOne(ctx context.Context, batch Batch) ([]Result, error) {
	shown := make([]promptItem, len(batch.Items))
	for i, in := range batch.Items {
		shown[i] = promptItem{
			N:            i,
			Filename:     in.Filename,
			PathSegments: in.PathSegments,
			Context:      in.Context,
			Tags:         in.Tags,
		}
	}
	files, err := json.MarshalIndent(shown, "", "  ")
	if err != nil {
		return nil, err
	}
	user := strings.NewReplacer(
		"__KNOWN_SOURCES__", l.sourceList,
		"__PAGE__", pageLine(batch),
		"__FILES__", string(files),
	).Replace(userPrompt)

	var got reply
	if _, err := l.client.RunJSON(ctx, openaicompat.Call{
		Model:     l.model,
		MaxTokens: l.maxTokens,
		System:    systemPrompt,
		User:      user,
		Reasoning: openaicompat.ReasoningOff,
	}, &got); err != nil {
		return nil, fmt.Errorf("normalize: %w", err)
	}

	byIndex := make(map[int]int, len(got.Items))
	for i, item := range got.Items {
		byIndex[item.N] = i
	}

	results := make([]Result, len(batch.Items))
	for i, in := range batch.Items {
		j, ok := byIndex[i]
		if !ok {
			slog.WarnContext(ctx, "normalize_no_answer", "media_url", in.MediaURL)
			continue
		}
		a := got.Items[j]
		r := Result{
			Title:     strings.TrimSpace(a.Title),
			Author:    strings.TrimSpace(a.Author),
			Location:  strings.TrimSpace(a.Location),
			Date:      strings.TrimSpace(a.Date),
			Language:  strings.TrimSpace(a.Language),
			DurationS: a.DurationS,

			CollectionTitle: strings.TrimSpace(a.CollectionTitle),
		}
		// The model states what the filename says; a range becomes one entry
		// per verse here rather than in the prompt, where it would be sixty
		// lines of output the model could miscount.
		for _, ref := range a.References {
			refs, note := domain.ExpandRefs(ref.Source, ref.Tokens)
			if note != "" {
				slog.WarnContext(ctx, "normalize_range_collapsed",
					"media_url", in.MediaURL, "reason", note)
			}
			r.References = append(r.References, refs...)
		}
		Validate(&r, l.knownSources, l.now())
		results[i] = r
	}
	return results, nil
}

func pageLine(b Batch) string {
	switch {
	case b.PageURL == "" && b.PageTitle == "":
		return "(none)"
	case b.PageTitle == "":
		return b.PageURL
	default:
		return b.PageURL + " — " + b.PageTitle
	}
}

// Series asks once whether a page without audio presents a cycle.
//
// It is one call per candidate page, not per recording, which is what makes it
// affordable: an archive has thousands of talks and a handful of courses.
func (l *LLM) Series(ctx context.Context, in SeriesInput) (*Series, error) {
	if len(in.Links) == 0 || len(in.Links) > maxSeriesLinks {
		return nil, nil
	}
	links, err := json.MarshalIndent(in.Links, "", "  ")
	if err != nil {
		return nil, err
	}
	user := "PAGE: " + in.PageURL + "\nTITLE: " + in.PageTitle +
		"\n\nTEXT:\n" + truncateRunes(in.PageText, seriesTextLimit) +
		"\n\nLINKS:\n" + string(links)

	var got Series
	if _, err := l.client.RunJSON(ctx, openaicompat.Call{
		Model:     l.model,
		MaxTokens: l.maxTokens,
		System:    seriesPrompt,
		User:      user,
		Reasoning: openaicompat.ReasoningOff,
	}, &got); err != nil {
		return nil, fmt.Errorf("series: %w", err)
	}
	if !got.IsSeries || strings.TrimSpace(got.Title) == "" {
		return nil, nil
	}
	got.Title = strings.TrimSpace(got.Title)

	// Only links we actually showed it can be members; anything else is
	// invention and would point membership at a page nobody visited.
	shown := make(map[string]bool, len(in.Links))
	for _, l := range in.Links {
		shown[l] = true
	}
	members := got.Members[:0]
	for _, m := range got.Members {
		if shown[m] {
			members = append(members, m)
		}
	}
	got.Members = members
	if len(got.Members) == 0 {
		return nil, nil
	}
	return &got, nil
}

// seriesTextLimit is how much of the page the series question needs. Its
// identity is at the top; the rest is the list we pass separately.
const seriesTextLimit = 4000

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
