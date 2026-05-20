// Package library holds the domain types for the canonical book corpus
// (verses, commentaries, prose chapters, letters, section titles) imported
// from gitabase. Lives in a SEPARATE SQLite file (library.db) from the
// track catalog (current.db), because the corpus changes rarely and the
// publish cadence is independent.
//
// References to authors / sources / locations are TEXT ids that point at
// the catalog (current.db). SQLite cannot enforce cross-DB FKs, so the
// application layer is responsible for keeping IDs in sync.
package library

// Verse is a canonical shloka addressed by (SourceID, Tokens).
//
// Text + Transliteration are NOT localized — Devanagari (or Bengali for CC)
// and IAST transliteration are the same regardless of which translation
// language the user reads. Translation belongs in VerseVariant.
type Verse struct {
	ID              string
	SourceID        string
	Tokens          string // "2.13" / "5.5.3" / "1.8.32"
	Text            string // original script (devanagari / bengali); may be empty
	Transliteration string // IAST plain text; may be empty
	Translations    map[string]string // language → translation
}

// DocumentKind discriminates the kinds of non-verse content in the library.
type DocumentKind string

const (
	DocKindCommentary    DocumentKind = "commentary"
	DocKindProseChapter  DocumentKind = "prose_chapter"
	DocKindLetter        DocumentKind = "letter"
)

// Document is a non-verse entity addressed by (SourceID, Kind, Tokens, AuthorID).
//
// When SourceID + Tokens match a Verse row, the document is a commentary on
// that verse (look up via JOIN). When no verse matches, the document stands
// on its own (a prose chapter, letter, etc.).
type Document struct {
	ID       string
	SourceID string
	Tokens   string
	AuthorID string
	Kind     DocumentKind
	Date     string // "YYYY-MM-DD" for letters; empty otherwise
	Bodies   map[string]DocumentBody // language → body+title
}

// DocumentBody is one localized representation of a document.
type DocumentBody struct {
	Title string // optional (letters have it; commentaries don't)
	Body  string // markdown
}

// Title is a localized title for a book section (canto / chapter) addressed
// by (SourceID, Tokens). Tokens length describes depth:
//   "5"   — canto / lila title
//   "5.5" — chapter title within a canto
//   "2"   — chapter title for a single-level book like BG
type Title struct {
	SourceID string
	Tokens   string
	Language string
	Title    string
}

// ListVersesOpts narrows a verse listing.
type ListVersesOpts struct {
	SourceID    string // required
	TokenPrefix string // optional, e.g. "5.5." to limit to chapter 5.5 of SB
	Language    string // optional, returns translation for this locale only
	Limit       int    // 0 = all (capped internally)
	Cursor      string // last-seen tokens, exclusive
}

// ListDocumentsOpts narrows a document listing.
type ListDocumentsOpts struct {
	SourceID    string       // optional
	Kind        DocumentKind // optional
	TokenPrefix string       // optional
	AuthorID    string       // optional
	Language    string       // optional, returns only that locale's body
	Limit       int
	Cursor      string
}

// ListTitlesOpts narrows a title listing.
type ListTitlesOpts struct {
	SourceID    string // optional
	TokenPrefix string // optional
	Language    string // optional
	Limit       int
	Cursor      string
}
