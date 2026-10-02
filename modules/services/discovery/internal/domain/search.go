package domain

import "time"

// SearchFilter is what narrows a search. Every set field must hold; within a
// list, any one value is enough.
//
// Sources are scripture codes as asked (BG, SB, CC_MADHYA) and Tokens a
// coordinate within them ("2.13"); a recording matches when one of its
// references holds both. Collection is a cycle's id or its title.
type SearchFilter struct {
	AuthorIDs  []int64
	Languages  []string
	Sources    []string
	Tokens     string
	Collection string
	DateFrom   *time.Time
	DateTo     *time.Time
}

// Narrowed reports whether any filter is set, which is what makes an exact
// scan worth weighing against the approximate index.
func (f SearchFilter) Narrowed() bool {
	return len(f.AuthorIDs) > 0 || len(f.Languages) > 0 || len(f.Sources) > 0 ||
		f.Tokens != "" || f.Collection != "" || f.DateFrom != nil || f.DateTo != nil
}

// Hit is one recording a search found, with the piece of text that matched.
//
// References are its passages as "SOURCE TOKENS", in their own order. Score is
// the lane's own measure until the lanes are fused.
type Hit struct {
	ItemID     int64
	MediaURL   string
	PageURL    string
	Title      string
	Author     string
	Location   string
	Language   string
	CoverURL   string
	RecordedOn *time.Time
	References []string
	Source     string
	Collection *HitCollection
	Chunk      string
	Summary    string
	Highlight  string
	Score      float64
	MediaState string
}

// HitCollection places a recording inside its cycle. Ordinal counts from one;
// Of is how many parts the cycle has.
type HitCollection struct {
	ID      int64
	Title   string
	URL     string
	Ordinal int
	Of      int
}

// Speaker is somebody the corpus knows under a spelling that was asked for,
// with how firmly that spelling names a person rather than an ordinary word.
type Speaker struct {
	// Spelling is the words from the question that found them.
	Spelling string
	Name     string
	// Own is how many recordings they are the speaker of; Other is how many
	// other people's recordings merely mention the spelling in their title.
	Own   int
	Other int
}

// Confidence is Own out of everything the spelling touches. Measured against
// the corpus, every real speaker scored 0.50 or better and every ordinary word
// 0.37 or worse: Krishna is 4 recordings against 284 mentions, Vrindavan 42
// against 434, while Ватсала дас is 2 against 2 and Парататтва дас 135 against
// 29.
func (s Speaker) Confidence() float64 {
	if s.Own+s.Other == 0 {
		return 0
	}
	return float64(s.Own) / float64(s.Own+s.Other)
}
