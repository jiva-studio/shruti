// Package domain holds the engine's vocabulary. Nothing here knows about any
// particular website: a source is a seed URL, and everything we learn about a
// recording is read out of text at runtime.
package domain

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Item is one discovered media file. MediaURL is the natural key.
//
// The struct has two halves and the split is load-bearing. Extraction fills the
// RAW half — what the page and the URL literally say. The normalizer fills the
// INTERPRETED half by handing that raw material to a model. Extraction never
// guesses meaning: deciding that a path segment is a speaker, or that "29.12.13"
// is a date rather than a reference, is a judgement about content, and a rule
// that gets it right on five sources silently gets it wrong on the sixth.
type Item struct {
	MediaURL string `json:"media_url"`
	PageURL  string `json:"page_url,omitempty"`

	// --- raw: filled by extraction ---

	// Filename, Path and PathSegments are the only metadata on sources that
	// publish a file tree and no page describing it.
	Filename     string   `json:"filename,omitempty"`
	Path         string   `json:"path,omitempty"`
	PathSegments []string `json:"path_segments,omitempty"`

	// Tags are what the file itself says about the recording, read from its ID3
	// or equivalent container metadata.
	Tags map[string]string `json:"tags,omitempty"`

	// --- interpreted: filled by the normalizer, never by extraction ---

	Title    string `json:"title,omitempty"`
	Author   string `json:"author,omitempty"`
	Location string `json:"location,omitempty"`
	Date     string `json:"date,omitempty"` // ISO 8601, YYYY-MM-DD
	Language string `json:"language,omitempty"`
	Duration string `json:"duration,omitempty"`

	// References is every scripture passage this recording is about. A lecture
	// commonly covers several, and a filename saying "01-01_18-78" means two of
	// them, not one strange one.
	References []Ref `json:"references,omitempty"`

	Ordinal int `json:"ordinal,omitempty"`
}

// Material is something a script read off a page and deliberately did not
// interpret: words the archive itself wrote beside a recording, handed on for
// the model to read.
//
// Labelled, because what a line *is* matters as much as what it says. A
// downloader's own label is not a title, and a model shown only the words will
// hand it straight back as one — which is how six thousand recordings came to
// be called "Chicago" and "Punjabi".
type Material struct {
	Label string `json:"label"`
	Text  string `json:"text"`
}

// Ref is a scripture reference in the corpus's own shape: a source code plus a
// single verse coordinate. It matches `track_references` so normalized output
// drops into the existing pipeline without a translation step.
type Ref struct {
	Source string `json:"source"` // BG, SB, CC_ADI, CC_MADHYA, CC_ANTYA, ISO, NOD, BS
	Tokens string `json:"tokens"` // "1.2.10"
}

// Label renders the reference the way a person writes it.
func (r Ref) Label() string { return strings.TrimSpace(r.Source + " " + r.Tokens) }

// maxRangeSpan is a backstop, and an admittedly arbitrary one.
//
// Whether "18-78" is a range or a chapter-verse coordinate is genuinely
// ambiguous, and only the source's own habit settles it — which is why the
// reading is left to the model. This number cannot recover the right answer;
// it only bounds the damage of a wrong one. It sits above the real blocks a
// single talk covers — BG 2.13-51 is forty verses and an ordinary subject —
// and below the hundreds a misread coordinate produces.
//
// The principled check is whether the verse exists at all, which needs the
// canon of chapter lengths this service does not carry.
const maxRangeSpan = 50

// ExpandRefs turns what a name says into one Ref per verse.
//
// A talk on "БГ 02.23-24" is two references, not one verse numbered 23-24 —
// the same rule the corpus parser applies, so both sides agree on what a
// reference is.
//
// A coordinate that does not fit its book's token scheme is dropped rather
// than stored: "SB 3.10-12" read as a range gives two-level coordinates, and a
// canto.chapter.verse book has no such verse for any of them to match. So is a
// range too wide to believe — the first verse of a misread coordinate is not
// the passage the talk was about.
func ExpandRefs(source, tokens string) ([]Ref, string) {
	source = strings.ToUpper(strings.TrimSpace(source))
	if source == "" {
		return nil, ""
	}
	depth := 0
	if src, ok := SourceByCode(source); ok {
		depth = src.Depth()
	}
	expanded := expandRange(normalizeTokens(tokens))
	if len(expanded) > maxRangeSpan {
		return nil, fmt.Sprintf("%s %s reads as %d verses and was dropped",
			source, tokens, len(expanded))
	}
	out := make([]Ref, 0, len(expanded))
	for _, t := range expanded {
		// Only a reading that produced several verses is checked against the
		// book's token scheme. One that produced a single token is whatever the
		// source wrote, down to a bare canto, and is stored as written; several
		// of the wrong depth mean the dash was a coordinate misread as a range.
		if len(expanded) > 1 && depth > 0 && len(strings.Split(t, ".")) != depth {
			return nil, fmt.Sprintf("%s %s reads as %q, which is not a %d-part coordinate",
				source, tokens, t, depth)
		}
		out = append(out, Ref{Source: source, Tokens: t})
	}
	return out, ""
}

// normalizeTokens strips the leading zeros archives pad their filenames with,
// so "02.23" and "2.23" are the same verse.
func normalizeTokens(s string) string {
	parts := strings.Split(strings.TrimSpace(s), ".")
	for i, p := range parts {
		segs := strings.Split(p, "-")
		for j, seg := range segs {
			segs[j] = stripLeadingZeros(seg)
		}
		parts[i] = strings.Join(segs, "-")
	}
	return strings.Join(parts, ".")
}

func stripLeadingZeros(s string) string {
	trimmed := strings.TrimLeft(s, "0")
	if trimmed == "" && s != "" {
		return "0"
	}
	return trimmed
}

// expandRange turns "2.23-24" into "2.23" and "2.24". Anything it cannot read
// as a range is left exactly as it came, so a surprise never becomes silent
// data loss.
func expandRange(s string) []string {
	dash := strings.LastIndex(s, "-")
	if dash < 0 {
		return []string{s}
	}
	base, suffix := s[:dash], s[dash+1:]
	end, err := strconv.Atoi(suffix)
	if err != nil || end < 0 {
		return []string{s}
	}

	prefix, startStr := "", base
	if dot := strings.LastIndex(base, "."); dot >= 0 {
		prefix, startStr = base[:dot+1], base[dot+1:]
	}
	start, err := strconv.Atoi(startStr)
	if err != nil || start < 0 || end < start {
		return []string{s}
	}
	out := make([]string, 0, end-start+1)
	for v := start; v <= end; v++ {
		out = append(out, prefix+strconv.Itoa(v))
	}
	return out
}

// Extraction is everything one response yielded, before the normalizer touches
// any of it.
type Extraction struct {
	URL       string `json:"url"`
	PageTitle string `json:"page_title,omitempty"`

	// PageText is the whole response as flat text. It is what gets embedded and
	// what the normalizer reads.
	PageText string `json:"page_text,omitempty"`

	Items []Item `json:"items,omitempty"`

	// Links are same-host URLs worth visiting next. The crawl loop consumes
	// these; parse reports them so you can see what a page would have queued.
	Links []string `json:"links,omitempty"`

	FetchedAt time.Time `json:"fetched_at"`
}

// Collection groups recordings into a series. Sources call it a playlist, a
// category, a seminar directory; grouping is discovered by the normalizer from
// the same text, never from a per-site rule.
type Collection struct {
	URL         string `json:"url"`
	ExternalID  string `json:"external_id,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Author      string `json:"author,omitempty"`

	MemberCount int      `json:"member_count,omitempty"`
	MemberURLs  []string `json:"member_urls,omitempty"`
}
