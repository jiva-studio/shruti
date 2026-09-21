// Package promote implements the corpus-promotion gate (issue #1232): the
// admin approves a user-generated "personal library" track and it becomes
// a normal corpus track for everyone, keeping its stable track_id.
//
// This is the "track.commit + catalog.publish" step of the promotion flow —
// but it writes the corpus row DIRECTLY via the same catalog CommitRepository
// that track.commit uses, because a pending track lives OUTSIDE the local
// ingest pipeline (there is no lake-registry stage payload / on-disk workspace
// to drive commit.UseCase.Run). The write is zero-copy: the corpus variant
// reuses the personal track's already-public CDN transcript/audio keys — no
// re-upload, no re-transcode.
//
// Metadata is normalized to canonical dict ids AT THE GATE: the admin resolves
// raw author/location/source strings via <dict>.resolve and mints canon via
// author.create / source.create / location.create, then passes the resolved
// ids here (or lets Approve fall back to an exact name lookup). Approve NEVER
// auto-creates dictionary entries from uncertain pipeline output.
//
// Approve stages the catalog write and marks the pending row consumed. Shipping
// the updated catalog to everyone is the existing async catalog.publish tool
// (corpus-wide + heavy S3 upload); the admin batches approvals, then publishes.
package promote

import (
	"context"
	"fmt"
	"strings"
	"time"

	domaincatalog "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/catalog"
	pendingport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/pending"
)

// UseCase wires the pending reader and the catalog write side.
type UseCase struct {
	Pending pendingport.Reader
	Catalog catalogport.CommitRepository
}

// Ref is a resolved scripture citation the admin passes at approval time.
type Ref struct {
	SourceID string
	Tokens   string
}

// Input is the approval request. All fields except TrackID are optional and
// default from the pending row / resolve fall-backs.
type Input struct {
	TrackID string

	// Explicit resolved dict ids (from <dict>.resolve / *.create). When empty,
	// Approve falls back to an exact name lookup on the pending raw string.
	AuthorID   string
	LocationID string
	References []Ref

	// Metadata overrides; default from the pending row.
	Language          string
	Title             string
	Date              string
	ContributorUserID string
}

// Result mirrors the commit result shape: OK plus, on refusal, the lists of
// what is missing / unresolved. A refusal writes nothing and leaves the
// pending row un-consumed so the admin can resolve and retry.
type Result struct {
	TrackID           string   `json:"track_id"`
	Language          string   `json:"language"`
	ContributorUserID string   `json:"contributor_user_id,omitempty"`
	OK                bool     `json:"ok"`
	Missing           []string `json:"missing,omitempty"`
	Unresolved        []string `json:"unresolved,omitempty"`
	// Note reminds the caller that shipping is the separate catalog.publish step.
	Note string `json:"note,omitempty"`
}

// ErrNotFound is returned when no pending row matches the track_id.
var ErrNotFound = fmt.Errorf("pending track not found")

func (uc UseCase) Approve(ctx context.Context, in Input) (Result, error) {
	p, ok, err := uc.Pending.Get(ctx, in.TrackID)
	if err != nil {
		return Result{}, err
	}
	if !ok {
		return Result{}, ErrNotFound
	}

	res := Result{TrackID: in.TrackID}

	lang := firstNonEmpty(in.Language, p.Lang)
	if lang == "" {
		res.Missing = append(res.Missing, "language")
	}
	res.Language = lang

	// Author (required). Explicit id verified against the live catalog; else an
	// exact lookup on the raw name.
	authorID := in.AuthorID
	if authorID != "" {
		if _, found, err := uc.Catalog.GetDict(ctx, domaincatalog.KindAuthor, authorID); err != nil {
			return Result{}, fmt.Errorf("lookup author id: %w", err)
		} else if !found {
			res.Unresolved = append(res.Unresolved, fmt.Sprintf("author id %q not in catalog", authorID))
		}
	} else if raw := strings.TrimSpace(p.AuthorRaw); raw != "" {
		id, found, err := uc.Catalog.LookupIDByName(ctx, domaincatalog.KindAuthor, raw, lang)
		if err != nil {
			return Result{}, fmt.Errorf("resolve author name: %w", err)
		}
		if !found {
			res.Unresolved = append(res.Unresolved,
				fmt.Sprintf("author %q — resolve via author.resolve / author.create, then pass author_id", raw))
		} else {
			authorID = id
		}
	} else {
		res.Missing = append(res.Missing, "author")
	}

	// Location (optional, but if present must resolve to canon at the gate).
	locationID := in.LocationID
	if locationID != "" {
		if _, found, err := uc.Catalog.GetDict(ctx, domaincatalog.KindLocation, locationID); err != nil {
			return Result{}, fmt.Errorf("lookup location id: %w", err)
		} else if !found {
			res.Unresolved = append(res.Unresolved, fmt.Sprintf("location id %q not in catalog", locationID))
		}
	} else if raw := strings.TrimSpace(p.LocationRaw); raw != "" {
		id, found, err := uc.Catalog.LookupIDByName(ctx, domaincatalog.KindLocation, raw, lang)
		if err != nil {
			return Result{}, fmt.Errorf("resolve location name: %w", err)
		}
		if !found {
			res.Unresolved = append(res.Unresolved,
				fmt.Sprintf("location %q — resolve via location.resolve / location.create, then pass location_id", raw))
		} else {
			locationID = id
		}
	}

	// References (optional). Each explicit ref's source must exist in canon.
	refs := make([]domaincatalog.TrackReference, 0, len(in.References))
	for i, r := range in.References {
		if strings.TrimSpace(r.SourceID) == "" {
			res.Unresolved = append(res.Unresolved, fmt.Sprintf("references[%d]: source_id empty", i))
			continue
		}
		if _, found, err := uc.Catalog.GetDict(ctx, domaincatalog.KindSource, r.SourceID); err != nil {
			return Result{}, fmt.Errorf("lookup source id: %w", err)
		} else if !found {
			res.Unresolved = append(res.Unresolved, fmt.Sprintf("references[%d]: source id %q not in catalog", i, r.SourceID))
			continue
		}
		refs = append(refs, domaincatalog.TrackReference{SourceID: r.SourceID, Tokens: r.Tokens})
	}

	title := strings.TrimSpace(firstNonEmpty(in.Title, p.TitleRaw))
	if title == "" {
		res.Missing = append(res.Missing, "title")
	}

	date := firstNonEmpty(in.Date, p.DateRaw)
	if date != "" {
		if _, err := time.Parse("2006-01-02", date); err != nil {
			res.Unresolved = append(res.Unresolved, fmt.Sprintf("date %q: want YYYY-MM-DD", date))
		}
	}

	// Zero-copy invariants: the personal track's public bytes must be addressable.
	if strings.TrimSpace(p.TranscriptPath) == "" {
		res.Missing = append(res.Missing, "transcript_path (pending row)")
	}
	if strings.TrimSpace(p.AudioPath) == "" {
		res.Missing = append(res.Missing, "audio_path (pending row)")
	}

	contributor := firstNonEmpty(in.ContributorUserID, p.OwnerID)

	if len(res.Missing) > 0 || len(res.Unresolved) > 0 {
		return res, nil // refusal: nothing written, pending row stays
	}

	sortRef := buildSortReference(ctx, uc.Catalog, refs, lang)

	trackRow := domaincatalog.TrackRow{
		ID:                p.TrackID,
		AuthorID:          authorID,
		LocationID:        locationID,
		Date:              date,
		Hidden:            false,
		ContributorUserID: contributor,
	}
	variantRow := domaincatalog.VariantRow{
		TrackID:        p.TrackID,
		Language:       lang,
		Title:          title,
		TranscriptPath: p.TranscriptPath,
		TranscriptKind: "generated",
		SortReference:  sortRef,
	}
	audios := []domaincatalog.AudioRow{{
		TrackID:  p.TrackID,
		Language: lang,
		Kind:     domaincatalog.AudioKindOriginal,
		Path:     p.AudioPath,
		Filesize: p.AudioSizeBytes,
		Duration: p.AudioDurationMs,
	}}

	if err := uc.Catalog.SaveTrack(ctx, trackRow, variantRow, audios, refs); err != nil {
		return Result{}, fmt.Errorf("catalog SaveTrack: %w", err)
	}

	if _, err := uc.Pending.MarkConsumed(ctx, p.TrackID); err != nil {
		// The corpus write already succeeded; a failed consume-mark is not
		// fatal (the row reconciles on the next producer pass). Surface it in
		// the note rather than failing the approval.
		res.Note = fmt.Sprintf("committed to corpus, but mark-consumed failed: %v; run catalog.publish to ship", err)
		res.OK = true
		res.ContributorUserID = contributor
		return res, nil
	}

	res.OK = true
	res.ContributorUserID = contributor
	res.Note = "committed to corpus (zero-copy); run catalog.publish to ship to everyone"
	return res, nil
}

// buildSortReference computes the per-locale by-reference sort key, mirroring
// commit.buildSortReference: leading localized source short_name prefix + a
// zero-padded numeric tail. Returns nil when the track has no references.
func buildSortReference(ctx context.Context, cat catalogport.CommitRepository, refs []domaincatalog.TrackReference, lang string) *string {
	if len(refs) == 0 {
		return nil
	}
	primaryShort := ""
	if entry, ok, _ := cat.GetDict(ctx, domaincatalog.KindSource, refs[0].SourceID); ok {
		primaryShort = entry.ShortName[lang]
		if primaryShort == "" {
			primaryShort = entry.ShortName["en"]
		}
	}
	parts := []string{}
	if primaryShort != "" {
		parts = append(parts, primaryShort)
	}
	for _, tok := range strings.Split(refs[0].Tokens, ".") {
		if isAllDigits(tok) {
			parts = append(parts, zeroPad6(tok))
		} else if tok != "" {
			parts = append(parts, tok)
		}
	}
	s := strings.Join(parts, "_")
	return &s
}

func zeroPad6(s string) string {
	if len(s) >= 6 {
		return s
	}
	return strings.Repeat("0", 6-len(s)) + s
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
