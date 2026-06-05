package attribution

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

// ImportPlan is the verse-centric YAML a curator authors: one entry per verse
// listing the topical labels (→ kind=boost) and user-style questions
// (→ kind=pinned) that verse authoritatively answers. Same shape the former
// Python attribution-importer consumed, so existing plans stay valid.
type ImportPlan struct {
	SourceID string            `yaml:"source_id"`
	Language string            `yaml:"language"`
	Verses   []ImportPlanVerse `yaml:"verses"`
}

type ImportPlanVerse struct {
	Tokens    string   `yaml:"tokens"`
	VerseID   string   `yaml:"verse_id"`
	Topics    []string `yaml:"topics"`
	Questions []string `yaml:"questions"`
	Documents []string `yaml:"documents"` // optional → ref_kind=document
}

// ImportResult is the rollup returned to the caller (mirrors the telemetry the
// Python importer printed).
type ImportResult struct {
	SourceID    string   `json:"source_id"`
	Language    string   `json:"language"`
	Verses      int      `json:"verses"`
	PinnedTexts int      `json:"pinned_texts"` // unique question texts
	BoostTexts  int      `json:"boost_texts"`  // unique topic texts
	Created     int      `json:"created"`      // attributions newly minted
	Existed     int      `json:"existed"`      // attributions reused (idempotent)
	RefsAdded   int      `json:"refs_added"`
	Errors      int      `json:"errors"`
	ErrorSample []string `json:"error_sample,omitempty"`
}

// ParseImportPlan unmarshals + validates a YAML plan.
func ParseImportPlan(data []byte) (ImportPlan, error) {
	var p ImportPlan
	if err := yaml.Unmarshal(data, &p); err != nil {
		return ImportPlan{}, fmt.Errorf("parse yaml: %w", err)
	}
	if p.Language == "" {
		return ImportPlan{}, fmt.Errorf("import plan: top-level `language` is required")
	}
	for i, v := range p.Verses {
		hasVerse := strings.TrimSpace(v.VerseID) != ""
		hasDocs := len(v.Documents) > 0
		if !hasVerse && !hasDocs {
			return ImportPlan{}, fmt.Errorf("import plan: verses[%d] needs verse_id or documents", i)
		}
	}
	return p, nil
}

// aggregated holds the dedup'd text→refs maps for one kind.
type aggregated struct {
	// ordered text → set of refs (kept ordered for deterministic output)
	texts map[string]map[library.AttributionRef]struct{}
	order []string
}

func newAggregated() *aggregated {
	return &aggregated{texts: map[string]map[library.AttributionRef]struct{}{}}
}

func (a *aggregated) add(text string, refs []library.AttributionRef) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if _, ok := a.texts[text]; !ok {
		a.texts[text] = map[library.AttributionRef]struct{}{}
		a.order = append(a.order, text)
	}
	for _, r := range refs {
		a.texts[text][r] = struct{}{}
	}
}

// Aggregate collapses the verse-centric plan into text→refs maps: identical
// text across verses becomes ONE attribution with multiple refs. Mirrors the
// Python importer's aggregate().
func Aggregate(p ImportPlan) (boost *aggregated, pinned *aggregated) {
	boost, pinned = newAggregated(), newAggregated()
	for _, v := range p.Verses {
		var refs []library.AttributionRef
		if strings.TrimSpace(v.VerseID) != "" {
			refs = append(refs, library.AttributionRef{Kind: "verse", TargetID: strings.TrimSpace(v.VerseID)})
		}
		for _, d := range v.Documents {
			if d = strings.TrimSpace(d); d != "" {
				refs = append(refs, library.AttributionRef{Kind: "document", TargetID: d})
			}
		}
		for _, t := range v.Topics {
			boost.add(t, refs)
		}
		for _, q := range v.Questions {
			pinned.add(q, refs)
		}
	}
	return boost, pinned
}

// Import runs a full plan: for every unique topic (kind=boost) and question
// (kind=pinned) text, Create (idempotent) then RefAdd each ref. Safe to
// re-run — Create reuses existing attributions and RefAdd is INSERT OR IGNORE,
// so no duplicates and no external checkpoint needed. Per-item errors are
// counted and sampled, not fatal (matches the importer's fail-soft contract).
func (uc UseCase) Import(ctx context.Context, p ImportPlan) (ImportResult, error) {
	boost, pinned := Aggregate(p)
	res := ImportResult{
		SourceID:    p.SourceID,
		Language:    p.Language,
		Verses:      len(p.Verses),
		BoostTexts:  len(boost.order),
		PinnedTexts: len(pinned.order),
	}

	run := func(agg *aggregated, kind library.AttributionKind) {
		for _, text := range agg.order {
			// Detect reuse vs fresh-mint for telemetry.
			_, existed, ferr := uc.Repo.AttributionFindByText(ctx, kind, p.Language, text)
			if ferr != nil {
				res.Errors++
				uc.sampleErr(&res, fmt.Sprintf("find %s %q: %v", kind, text, ferr))
				continue
			}
			id, err := uc.Create(ctx, kind, p.Language, text)
			if err != nil {
				res.Errors++
				uc.sampleErr(&res, fmt.Sprintf("create %s %q: %v", kind, text, err))
				continue
			}
			if existed {
				res.Existed++
			} else {
				res.Created++
			}
			for _, ref := range sortedRefs(agg.texts[text]) {
				if err := uc.RefAdd(ctx, id, ref); err != nil {
					res.Errors++
					uc.sampleErr(&res, fmt.Sprintf("ref_add %s→%s/%s: %v", id, ref.Kind, ref.TargetID, err))
					continue
				}
				res.RefsAdded++
			}
		}
	}
	run(boost, library.AttrBoost)
	run(pinned, library.AttrPinned)
	return res, nil
}

func (uc UseCase) sampleErr(res *ImportResult, msg string) {
	if len(res.ErrorSample) < 10 {
		res.ErrorSample = append(res.ErrorSample, msg)
	}
}

// sortedRefs gives a deterministic ref order (kind, then target_id).
func sortedRefs(set map[library.AttributionRef]struct{}) []library.AttributionRef {
	out := make([]library.AttributionRef, 0, len(set))
	for r := range set {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].TargetID < out[j].TargetID
	})
	return out
}
