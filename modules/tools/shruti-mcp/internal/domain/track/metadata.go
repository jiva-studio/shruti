package track

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Metadata is the result of filename parsing — typically by an LLM
// extractor or the canonical-layout parser. The struct is immutable
// after construction: callers build a MetadataSpec, hand it to
// NewMetadata, and read back through the accessor methods.
//
// Raw values (AuthorRaw / LocationRaw) are not yet resolved against the
// catalog — see catalog.Resolver. References are likewise raw.
type Metadata struct {
	date            *time.Time
	authorRaw       string
	locationRaw     string
	title           string
	titleIsFallback bool
	languages       []string
	references      []RefRaw
	kindTag         string
}

// MetadataSpec is the writable shape extractors / parsers populate as
// they walk the source. Hand off to NewMetadata once filled in.
//
// MetadataSpec is intentionally exported and mutable so canonical-parser
// + LLM extractors can build it field-by-field without inventing builder
// methods for every field. Validation lives at the NewMetadata boundary.
type MetadataSpec struct {
	Date            *time.Time
	AuthorRaw       string
	LocationRaw     string
	Title           string
	TitleIsFallback bool
	Languages       []string
	References      []RefRaw
	KindTag         string
}

// kindTagWhitelist mirrors KindTagToID — same set, validated up front
// so a typo never leaks past the extractor stage.
var kindTagWhitelist = map[string]struct{}{
	"morning_walk":     {},
	"conversation":     {},
	"interview":        {},
	"press_conference": {},
	"address":          {},
	"vyasa_puja":       {},
	"initiation":       {},
	"wedding":          {},
	"festival":         {},
	"bhajan":           {},
	"other":            {},
}

// NewMetadata validates the spec and returns an immutable Metadata.
// Errors:
//   - title empty (after trim)
//   - kindTag set but not in whitelist
//   - references entry with empty SourceCode
//
// Title-is-fallback is a flag, not an error — the metadata stage may
// legitimately produce a fallback title; commit refuses it later.
// Date may be nil at this stage (LLM didn't find one); commit also
// catches that downstream via MinimallyComplete.
func NewMetadata(spec MetadataSpec) (Metadata, error) {
	if strings.TrimSpace(spec.Title) == "" {
		return Metadata{}, errors.New("metadata: title empty")
	}
	if spec.KindTag != "" {
		if _, ok := kindTagWhitelist[spec.KindTag]; !ok {
			return Metadata{}, fmt.Errorf("metadata: unknown kind_tag %q", spec.KindTag)
		}
	}
	for i, r := range spec.References {
		if strings.TrimSpace(r.SourceCode) == "" {
			return Metadata{}, fmt.Errorf("metadata: references[%d] has empty source_code", i)
		}
	}
	// Defensive copies of caller-owned slices so later mutation can't
	// reach into the immutable value.
	langs := append([]string(nil), spec.Languages...)
	refs := append([]RefRaw(nil), spec.References...)
	var datePtr *time.Time
	if spec.Date != nil {
		t := *spec.Date
		datePtr = &t
	}
	return Metadata{
		date:            datePtr,
		authorRaw:       spec.AuthorRaw,
		locationRaw:     spec.LocationRaw,
		title:           spec.Title,
		titleIsFallback: spec.TitleIsFallback,
		languages:       langs,
		references:      refs,
		kindTag:         spec.KindTag,
	}, nil
}

// Accessors. Slice/pointer fields return defensive copies so the
// caller can't smuggle mutation back into the value object.

func (m Metadata) Title() string         { return m.title }
func (m Metadata) TitleIsFallback() bool { return m.titleIsFallback }
func (m Metadata) AuthorRaw() string     { return m.authorRaw }
func (m Metadata) LocationRaw() string   { return m.locationRaw }
func (m Metadata) KindTag() string       { return m.kindTag }

func (m Metadata) Date() *time.Time {
	if m.date == nil {
		return nil
	}
	t := *m.date
	return &t
}

func (m Metadata) Languages() []string {
	if m.languages == nil {
		return nil
	}
	return append([]string(nil), m.languages...)
}

func (m Metadata) References() []RefRaw {
	if m.references == nil {
		return nil
	}
	return append([]RefRaw(nil), m.references...)
}

// IsZero reports whether m is the zero value (e.g. Metadata{} returned
// from an error path). Useful for callers that want to distinguish
// "no metadata yet" from "empty title" without reaching into private
// fields.
func (m Metadata) IsZero() bool {
	return m.title == "" && m.date == nil && m.authorRaw == "" &&
		m.locationRaw == "" && len(m.languages) == 0 &&
		len(m.references) == 0 && m.kindTag == ""
}

// MinimallyComplete is the domain invariant the metadata stage emits
// and commit verifies: title and date have to be there in some form.
// It does NOT enforce TitleIsFallback=false — commit applies that as
// a separate rule because the stage payload legitimately carries
// fallback titles while the operator decides via track_set_metadata.
func (m Metadata) MinimallyComplete() error {
	if strings.TrimSpace(m.title) == "" {
		return errors.New("title: empty")
	}
	if m.date == nil {
		return errors.New("date: missing")
	}
	return nil
}

// metadataJSON is the wire shape — JSON tags here are the canonical
// keys used in stage payloads and meta.json sidecars.
type metadataJSON struct {
	Date            string   `json:"date,omitempty"`
	AuthorRaw       string   `json:"author_raw,omitempty"`
	LocationRaw     string   `json:"location_raw,omitempty"`
	Title           string   `json:"title"`
	TitleIsFallback bool     `json:"title_is_fallback,omitempty"`
	Languages       []string `json:"languages,omitempty"`
	References      []RefRaw `json:"references,omitempty"`
	KindTag         string   `json:"kind_tag,omitempty"`
}

func (m Metadata) MarshalJSON() ([]byte, error) {
	w := metadataJSON{
		AuthorRaw:       m.authorRaw,
		LocationRaw:     m.locationRaw,
		Title:           m.title,
		TitleIsFallback: m.titleIsFallback,
		Languages:       m.languages,
		References:      m.references,
		KindTag:         m.kindTag,
	}
	if m.date != nil {
		w.Date = m.date.Format("2006-01-02")
	}
	return json.Marshal(w)
}

// UnmarshalJSON reconstructs a Metadata without re-running NewMetadata's
// validation — by the time a payload reaches us off disk it has already
// been through the extractor that produced it. Callers that want a
// stricter check call MinimallyComplete on the loaded value.
func (m *Metadata) UnmarshalJSON(b []byte) error {
	var raw metadataJSON
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	var datePtr *time.Time
	if raw.Date != "" {
		t, err := time.Parse("2006-01-02", raw.Date)
		if err != nil {
			return fmt.Errorf("metadata: parse date %q: %w", raw.Date, err)
		}
		datePtr = &t
	}
	m.date = datePtr
	m.authorRaw = raw.AuthorRaw
	m.locationRaw = raw.LocationRaw
	m.title = raw.Title
	m.titleIsFallback = raw.TitleIsFallback
	m.languages = append([]string(nil), raw.Languages...)
	m.references = append([]RefRaw(nil), raw.References...)
	m.kindTag = raw.KindTag
	return nil
}

// RefRaw is one scripture reference parsed from a filename.
// SourceCode is the legacy short form ("BG", "SB", "CC", ...). It still
// needs to be resolved into a sources.id by catalog.Resolver before
// commit. Tokens encode chapter/verse like "10.5" or "10.5.12".
type RefRaw struct {
	SourceCode string `json:"source_code"`
	Tokens     string `json:"tokens,omitempty"`
}
