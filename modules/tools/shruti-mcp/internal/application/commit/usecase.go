// Package commit gates writeback to current.db with a strict validation
// pass. The track is only published to the catalog when EVERY required field
// is present and well-formed (see plan §"Стадия commit: валидация ПЕРЕД
// записью в current.db"). Anything missing leaves the track in
// commit(lang)=failed and surfaces a list of fixes.
package commit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/audiotag"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/extractmeta"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/stagefail"
	domaincatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	audioport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	fsport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/fs"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
)

type UseCase struct {
	Registry    lakeport.Registry
	Audio       audioport.Store
	Transcripts transcriptport.Store
	Catalog     catalogport.CommitRepository
	FS          fsport.Existence
	OutDir      string

	// AudioTag is invoked at the end of a successful commit so the public
	// mp3 picks up ID3 metadata reflecting the just-committed catalog state.
	// Optional: nil disables auto-tagging (the standalone track_tag_audio
	// MCP tool stays available for manual re-tagging either way).
	AudioTag *audiotag.UseCase
}

type Result struct {
	TrackId  track.Id `json:"track_id"`
	Language string   `json:"language"`
	OK       bool     `json:"ok"`
	Missing  []string `json:"missing,omitempty"`
	Invalid  []string `json:"invalid,omitempty"`
}

// Run validates the track + variant for `language` against the contract and,
// on success, writes the rows to current.db.
func (uc UseCase) Run(ctx context.Context, id track.Id, language string) (res Result, rerr error) {
	stageKey := pipeline.Key{Stage: pipeline.StageCommitted, Variant: language}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		return Result{}, fmt.Errorf("commit: another worker holds stage for %s/%s", id, language)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	res = Result{TrackId: id, Language: language}

	// Read the metadata stage payload to get author/location/date/refs/title.
	metaPayload, _, err := uc.Registry.GetStage(ctx, id, pipeline.Key{Stage: pipeline.StageMetadataExtracted})
	if err != nil {
		return uc.fail(ctx, id, stageKey, fmt.Errorf("read metadata stage: %w", err))
	}
	if len(metaPayload.Payload) == 0 {
		return uc.fail(ctx, id, stageKey, fmt.Errorf("metadata_extract not run yet"))
	}

	var meta extractmeta.Result
	if err := json.Unmarshal(metaPayload.Payload, &meta); err != nil {
		return uc.fail(ctx, id, stageKey, fmt.Errorf("parse metadata payload: %w", err))
	}

	// Pick the language to look up names in. Default to commit's variant
	// language; if the extractor saw a different primary language for
	// the audio (multi-locale catalog dicts, e.g. EN-only authors),
	// that's where the name lives. Falls back to language.
	lookupLang := language
	for _, l := range meta.Languages {
		if l != "" {
			lookupLang = l
			break
		}
	}

	// 1. Required scalar fields. The extractor's Resolves[] entries carry
	// the canonical dict id (MatchedID) — that's the stable handle that
	// survives catalog renames. Look up by id via GetDict; only fall back
	// to a name lookup when the resolver left no id (very legacy payloads).
	var authorID, locationID string
	if aid := matchedDictID(meta.Resolves, "author", ""); aid != "" {
		_, ok, err := uc.Catalog.GetDict(ctx, domaincatalog.KindAuthor, aid)
		if err != nil {
			return uc.fail(ctx, id, stageKey, fmt.Errorf("lookup author by id: %w", err))
		}
		if !ok {
			res.Invalid = append(res.Invalid, fmt.Sprintf("author id %q not in catalog (deleted?) — re-run metadata extract or fix payload via track_set_metadata", aid))
		} else {
			authorID = aid
		}
	} else if strings.TrimSpace(meta.AuthorName) == "" {
		res.Missing = append(res.Missing, "author_name")
	} else {
		aid, ok, err := uc.Catalog.LookupIDByName(ctx, domaincatalog.KindAuthor, meta.AuthorName, lookupLang)
		if err != nil {
			return uc.fail(ctx, id, stageKey, fmt.Errorf("lookup author by name: %w", err))
		}
		if !ok {
			res.Invalid = append(res.Invalid, fmt.Sprintf("author %q not in catalog (rename/merge?) — re-run metadata extract or fix payload via track_set_metadata", meta.AuthorName))
		} else {
			authorID = aid
		}
	}
	if lid := matchedDictID(meta.Resolves, "location", ""); lid != "" {
		_, ok, err := uc.Catalog.GetDict(ctx, domaincatalog.KindLocation, lid)
		if err != nil {
			return uc.fail(ctx, id, stageKey, fmt.Errorf("lookup location by id: %w", err))
		}
		if !ok {
			res.Invalid = append(res.Invalid, fmt.Sprintf("location id %q not in catalog (deleted?) — re-run metadata extract or fix payload via track_set_metadata", lid))
		} else {
			locationID = lid
		}
	} else if strings.TrimSpace(meta.LocationName) != "" {
		lid, ok, err := uc.Catalog.LookupIDByName(ctx, domaincatalog.KindLocation, meta.LocationName, lookupLang)
		if err != nil {
			return uc.fail(ctx, id, stageKey, fmt.Errorf("lookup location by name: %w", err))
		}
		if !ok {
			res.Invalid = append(res.Invalid, fmt.Sprintf("location %q not in catalog (rename/merge?) — re-run metadata extract or fix payload via track_set_metadata", meta.LocationName))
		} else {
			locationID = lid
		}
	}
	if meta.Date != "" {
		if _, err := time.Parse("2006-01-02", meta.Date); err != nil {
			res.Invalid = append(res.Invalid, fmt.Sprintf("date: %v", err))
		}
	}
	if strings.TrimSpace(meta.Title) == "" {
		res.Missing = append(res.Missing, "title")
	}

	// 2. References are optional (conversations/walks/lectures-without-cited-verse
	// have no scripture reference). When present, each entry resolves to a
	// source via Resolves[] — match by query=SourceCode to find the
	// matched_id, then verify against the live catalog by id.
	resolvedRefs := make([]domaincatalog.TrackReference, 0, len(meta.References))
	for i, r := range meta.References {
		if sid := matchedDictID(meta.Resolves, "source", r.SourceCode); sid != "" {
			_, ok, err := uc.Catalog.GetDict(ctx, domaincatalog.KindSource, sid)
			if err != nil {
				return uc.fail(ctx, id, stageKey, fmt.Errorf("lookup source by id: %w", err))
			}
			if !ok {
				res.Invalid = append(res.Invalid, fmt.Sprintf("references[%d]: source id %q not in catalog (deleted?) — re-run metadata extract", i, sid))
				continue
			}
			resolvedRefs = append(resolvedRefs, domaincatalog.TrackReference{SourceID: sid, Tokens: r.Tokens})
			continue
		}
		if strings.TrimSpace(r.SourceShortName) == "" {
			res.Invalid = append(res.Invalid, fmt.Sprintf("references[%d]: source_short_name empty (raw code %q)", i, r.SourceCode))
			continue
		}
		sid, ok, err := uc.Catalog.LookupIDByName(ctx, domaincatalog.KindSource, r.SourceShortName, lookupLang)
		if err != nil {
			return uc.fail(ctx, id, stageKey, fmt.Errorf("lookup source by short_name: %w", err))
		}
		if !ok {
			res.Invalid = append(res.Invalid, fmt.Sprintf("references[%d]: source %q not in catalog (rename/delete?) — re-run metadata extract", i, r.SourceShortName))
			continue
		}
		resolvedRefs = append(resolvedRefs, domaincatalog.TrackReference{SourceID: sid, Tokens: r.Tokens})
	}

	// 3. Audio invariants — file exists, duration > 0, bytes > 0.
	audioPath := uc.Audio.PublicAudioPath(id, audioport.VersionOriginal)
	if ok, err := uc.FS.Exists(ctx, audioPath); err != nil {
		res.Invalid = append(res.Invalid, fmt.Sprintf("audio: stat failed at %s: %v", audioPath, err))
	} else if !ok {
		res.Invalid = append(res.Invalid, fmt.Sprintf("audio: file missing at %s (run audio_normalize)", audioPath))
	}
	if meta.Audio.DurationMs <= 0 {
		res.Invalid = append(res.Invalid, "audio.duration_ms must be > 0")
	}
	if meta.Audio.SizeBytes <= 0 {
		res.Invalid = append(res.Invalid, "audio.size_bytes must be > 0")
	}

	// 4. Transcript file invariants.
	// (a) file present on disk; (b) parses as a Reviewed transcript; (c) has
	// at least one block. Without (c), an empty transcript can sneak through
	// when whisper returns 0 segments (silent or sub-second source) or when
	// every chunk lands in fallback with no usable text — commit must refuse
	// rather than write an unusable record into the catalog.
	transcriptPath := publicTranscriptDiskPath(uc.OutDir, id, language)
	if ok, err := uc.FS.Exists(ctx, transcriptPath); err != nil {
		res.Invalid = append(res.Invalid, fmt.Sprintf("transcript: stat failed at %s: %v", transcriptPath, err))
	} else if !ok {
		res.Invalid = append(res.Invalid, fmt.Sprintf("transcript: file missing at %s (run transcript_review)", transcriptPath))
	} else {
		reviewed, err := uc.Transcripts.ReadReviewed(ctx, id, language)
		if err != nil {
			res.Invalid = append(res.Invalid, fmt.Sprintf("transcript: parse failed at %s: %v", transcriptPath, err))
		} else if len(reviewed.Blocks) == 0 {
			res.Invalid = append(res.Invalid, fmt.Sprintf("transcript: %s has no blocks (re-run transcript_create + transcript_review)", transcriptPath))
		}
	}

	// 5. Refuse if anything is missing or invalid.
	if len(res.Missing) > 0 || len(res.Invalid) > 0 {
		body, _ := json.Marshal(res)
		_ = uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusFailed, body, "validation failed")
		return res, nil // NB: not an error from Go's perspective; result has details
	}

	// 6. Build sort key for the variant. sort_reference is per-language
	// (lives on the variant) because the chip prefix renders in the user's
	// locale. Look up the primary source's short_name in the committing
	// language to seed the reference prefix. The mobile sort by date orders
	// directly on tracks.date (YYYY-MM-DD lexicographic == chronological)
	// so no separate sort_date is stored.
	primaryShort := ""
	if len(resolvedRefs) > 0 {
		entry, ok, _ := uc.Catalog.GetDict(ctx, domaincatalog.KindSource, resolvedRefs[0].SourceID)
		if ok {
			primaryShort = entry.ShortName[language]
			if primaryShort == "" {
				primaryShort = entry.ShortName["en"]
			}
		}
	}
	sortRef := buildSortReference(resolvedRefs, primaryShort)

	// 7. Save into catalog.
	var tagIDs []string
	if tid := track.KindTagToID(meta.KindTag); tid != "" {
		tagIDs = []string{tid}
	}
	trackRow := domaincatalog.TrackRow{
		Id:         string(id),
		AuthorID:   authorID,
		LocationID: locationID,
		Date:       meta.Date,
		Hidden:     false,
		TagIDs:     tagIDs,
	}
	variantRow := domaincatalog.VariantRow{
		TrackID:        string(id),
		Language:       language,
		Title:          strings.TrimSpace(meta.Title),
		TranscriptPath: uc.Transcripts.PublicTranscriptKey(id, language),
		TranscriptKind: "generated",
		SortReference:  sortRef,
	}
	// The published recording is the 'original' audio version. The denoiser
	// adds a 'clean' track_audio row later.
	audios := []domaincatalog.AudioRow{{
		TrackID:  string(id),
		Language: language,
		Kind:     domaincatalog.AudioKindOriginal,
		Path:     fmt.Sprintf("public/tracks/%s/audio/original.mp3", string(id)),
		Filesize: meta.Audio.SizeBytes,
		Duration: meta.Audio.DurationMs,
	}}

	if err := uc.Catalog.SaveTrack(ctx, trackRow, variantRow, audios, resolvedRefs); err != nil {
		return uc.fail(ctx, id, stageKey, fmt.Errorf("catalog SaveTrack: %w", err))
	}

	if uc.AudioTag != nil {
		if _, err := uc.AudioTag.Run(ctx, id, language); err != nil {
			return uc.fail(ctx, id, stageKey, fmt.Errorf("audiotag: %w", err))
		}
	}

	res.OK = true
	body, _ := json.Marshal(res)
	if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, body, ""); err != nil {
		return Result{}, err
	}
	return res, nil
}

// RollbackIfCommitted removes any tracks/variants committed for the given
// track from current.db. Called when an earlier stage is force-rerun and
// the cascade resets commit(lang) → pending.
func (uc UseCase) RollbackIfCommitted(ctx context.Context, id track.Id) error {
	stages, err := uc.Registry.ListAllStages(ctx, id)
	if err != nil {
		return err
	}
	for _, sr := range stages {
		if sr.Key.Stage != pipeline.StageCommitted {
			continue
		}
		if sr.Status == pipeline.StatusDone {
			if err := uc.Catalog.DeleteTrackVariant(ctx, string(id), sr.Key.Variant); err != nil {
				return err
			}
		}
	}
	return nil
}

func (uc UseCase) fail(ctx context.Context, id track.Id, key pipeline.Key, err error) (Result, error) {
	_ = uc.Registry.SetStage(ctx, id, key, pipeline.StatusFailed, nil, err.Error())
	return Result{TrackId: id, Language: key.Variant, OK: false, Invalid: []string{err.Error()}}, err
}

// matchedDictID picks the canonical dict id the extractor's resolver
// recorded for (kind, query). For author/location there's only one entry
// per kind, so pass query="" to match the first one. For source there
// can be many refs; pass the raw SourceCode as it appears in the
// reference to disambiguate. Returns "" when no entry was resolved.
func matchedDictID(resolves []extractmeta.Resolve, kind, query string) string {
	for _, r := range resolves {
		if r.Kind != kind || r.MatchedID == "" {
			continue
		}
		if query == "" || r.Query == query {
			return r.MatchedID
		}
	}
	return ""
}

// buildSortReference computes the per-locale by-reference sort key.
// Leading prefix is the localized source short_name (so "БГ_…" < "ШБ_…" in
// Cyrillic and "BG_…" < "SB_…" in Latin sort the same alphabetic order the
// user sees in chips). Numeric tail uses 6-char zero padding for stable
// lexical compare across chapter/verse magnitudes. Returns nil when the
// track has no scriptural references — the consumer sorts NULL last
// regardless of locale via SQL `NULLS LAST`.
//
//   refs[0].Tokens = "3.25.12", primaryShort = "ШБ" → "ШБ_000003_000025_000012"
//   refs[0].Tokens = "",        primaryShort = "BG" → "BG"
//   no refs                                          → nil
func buildSortReference(refs []domaincatalog.TrackReference, primaryShort string) *string {
	if len(refs) == 0 {
		return nil
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

// publicTranscriptDiskPath mirrors transcriptstore/fs.Store.PublicTranscriptPath
// without forcing a port import. Used purely for os.Stat invariant check.
func publicTranscriptDiskPath(outDir string, id track.Id, lang string) string {
	return fmt.Sprintf("%s/public/tracks/%s/transcripts/%s.json", outDir, string(id), lang)
}
