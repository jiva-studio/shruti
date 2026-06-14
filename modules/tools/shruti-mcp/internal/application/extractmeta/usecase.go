// Package extractmeta runs filename-based metadata extraction and resolves
// raw author/location/source strings against the catalog. When the resolver
// chain finds no match it auto-creates the missing dict entry (one row in
// the track's first language; sources also get short_name=query) so the
// downstream commit stage always has non-empty IDs to reference. Track rows
// themselves are still written exclusively by commit.
package extractmeta

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/stagefail"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	audioport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/dicttranslate"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/ids"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	metaport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/metadata"
)

type UseCase struct {
	Registry        lakeport.Registry
	Audio           audioport.Store
	Probe           audioport.Probe
	Catalog         catalogport.DictRepository
	FuzzyIndex      catalogport.DictFuzzyIndex // trigram prefilter for LLM resolver candidates
	Extractor       metaport.Extractor
	Resolver        catalogport.Resolver
	Minter          ids.Minter               // used to mint IDs when auto-creating a missing dict entry
	Translator      dicttranslate.Translator // optional; nil falls back to single-locale auto-create
	OutDir          string
	InDir           string // input lake root (same cfg.In as tools.Deps.InDir); used to compute relPath for the extractor
	DefaultLanguage string // fallback when meta.Languages is empty (used as the locale of an auto-created dict row)

	// runMemo dedups LLM calls for repeated raw strings within a single
	// MCP-process lifetime (e.g. 1568 EN tracks all carrying author "Srila
	// Prabhupada" produce one LLM call instead of 1568). Pure in-memory:
	// dies with the process, never persisted, cannot drift relative to
	// catalog. Cleared by FuzzyIndex.Rebuild on dict mutations is *not*
	// strictly needed since stale names just yield commit-time lookup
	// failures instead of silent FK regressions.
	runMemo sync.Map // key string → resolveMemo
}

type memoKey struct {
	kind     catalog.Kind
	query    string
	language string
}

func (k memoKey) String() string {
	return string(k.kind) + "|" + k.language + "|" + k.query
}

type resolveMemo struct {
	ID         string
	Name       string
	Confidence catalogport.Confidence
	Provider   string
	Reasoning  string
}

// Result is the rich payload of a successful extract — for stage payload + meta.json.
//
// Dict references are stored as **canonical names**, never ids. Commit
// re-looks-up id from name against the live catalog at write time, so a
// manual catalog edit (rename/merge) propagates without touching the
// lake. The catalog is the single source of truth for "name → id".
type Result struct {
	TrackId         track.Id            `json:"track_id"`
	Filename        string              `json:"filename"`
	Title           string              `json:"title"`
	TitleIsFallback bool                `json:"title_is_fallback"`
	Date            string              `json:"date,omitempty"`
	Languages       []string            `json:"languages"`
	AuthorName      string              `json:"author_name,omitempty"`   // canonical full_name in extracting language
	AuthorRaw       string              `json:"author_raw,omitempty"`
	LocationName    string              `json:"location_name,omitempty"` // canonical full_name
	LocationRaw     string              `json:"location_raw,omitempty"`
	References      []ResolvedReference `json:"references"`
	Audio           audioport.Info      `json:"audio"`
	Resolves        []Resolve           `json:"resolves"` // detailed resolver outcomes for audit
	// KindTag carries the canonical recording-type slug (morning_walk,
	// conversation, …). Resolved into TagID by commit via a static map.
	KindTag string `json:"kind_tag,omitempty"`
}

type ResolvedReference struct {
	SourceCode      string `json:"source_code"`
	SourceShortName string `json:"source_short_name,omitempty"` // canonical short_name in extracting language
	Tokens          string `json:"tokens"`
}

type Resolve struct {
	Kind       string `json:"kind"`
	Query      string `json:"query"`
	MatchedID  string `json:"matched_id,omitempty"`
	Confidence string `json:"confidence"`
	Provider   string `json:"provider"`
	Reasoning  string `json:"reasoning,omitempty"`
}

func (uc UseCase) Run(ctx context.Context, id track.Id, srcPath string) (res Result, rerr error) {
	stageKey := pipeline.Key{Stage: pipeline.StageMetadataExtracted}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		return Result{}, fmt.Errorf("metadata: another worker holds stage for %s", id)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	// 1. Path → metadata via LLM extractor. Pass the lake-relative path so the
	// extractor can use parent directory names as a hint (e.g. an author-named
	// folder when the basename omits the author).
	fname := filepath.Base(srcPath)
	relPath := fname
	if uc.InDir != "" {
		if rp, err := filepath.Rel(uc.InDir, srcPath); err == nil && !strings.HasPrefix(rp, "..") {
			relPath = rp
		}
	}
	knownSourceCodes := uc.knownSourceShortNames(ctx)
	meta, err := uc.Extractor.Extract(ctx, relPath, knownSourceCodes)
	if err != nil {
		return Result{}, err
	}

	// 2. Audio probe on the canonical file.
	audioPath := uc.Audio.PublicAudioPath(id, audioport.VersionOriginal)
	info, err := uc.Probe.Probe(ctx, audioPath)
	if err != nil {
		return Result{}, fmt.Errorf("ffprobe %s: %w (run audio_normalize first?)", audioPath, err)
	}

	// 3. Resolve author/location/sources against the catalog.
	authorRaw := meta.AuthorRaw()
	locationRaw := meta.LocationRaw()
	languages := meta.Languages()
	res = Result{
		TrackId:         id,
		Filename:        fname,
		Title:           meta.Title(),
		TitleIsFallback: meta.TitleIsFallback(),
		Languages:       languages,
		AuthorRaw:       authorRaw,
		LocationRaw:     locationRaw,
		Audio:           info,
		KindTag:         meta.KindTag(),
	}
	if d := meta.Date(); d != nil {
		res.Date = d.Format("2006-01-02")
	}

	lang := uc.entryLanguage(languages)
	if authorRaw != "" {
		r, err := uc.resolveOne(ctx, catalog.KindAuthor, authorRaw, lang)
		if err == nil {
			res.AuthorName = r.MatchedName
			res.Resolves = append(res.Resolves, asResolve("author", authorRaw, r))
		}
	}
	if locationRaw != "" {
		r, err := uc.resolveOne(ctx, catalog.KindLocation, locationRaw, lang)
		if err == nil {
			res.LocationName = r.MatchedName
			res.Resolves = append(res.Resolves, asResolve("location", locationRaw, r))
		}
	}
	for _, ref := range meta.References() {
		ref := ref
		rr, err := uc.resolveOne(ctx, catalog.KindSource, ref.SourceCode, lang)
		var srcShort string
		if err == nil {
			srcShort = rr.MatchedName
			res.Resolves = append(res.Resolves, asResolve("source", ref.SourceCode, rr))
		}
		res.References = append(res.References, ResolvedReference{
			SourceCode:      ref.SourceCode,
			SourceShortName: srcShort,
			Tokens:          ref.Tokens,
		})
	}

	// 4. Persist meta.json sidecar.
	metaDir := filepath.Join(uc.OutDir, "artifacts", "tracks", string(id))
	if err := os.MkdirAll(metaDir, 0o755); err != nil {
		return Result{}, err
	}
	body, _ := json.MarshalIndent(res, "", "  ")
	if err := atomicWrite(filepath.Join(metaDir, "meta.json"), body); err != nil {
		return Result{}, err
	}

	// 5. Mark stage Done.
	if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, body, ""); err != nil {
		return Result{}, err
	}
	return res, nil
}

// resolveOne maps a raw extracted string to a canonical dict entry.
//
// Resolution order:
//  1. catalog exact match by canonical name (full_name for author /
//     location / tag, short_name for source) — fast common case for
//     repeat strings already in dict
//  2. runMemo (in-memory dedup of LLM calls within the MCP-process
//     lifetime) — collapses 1568 identical "Srila Prabhupada" strings
//     into one LLM call
//  3. trigram-prefilter via FuzzyIndex → up to 20 phonetically-relevant
//     candidates from catalog dict; LLM sees a short relevant list
//     instead of "top-200 unfiltered" (the old failure mode that minted
//     "Srila Prabhupada" as a duplicate of "A. C. Bhaktivedanta Swami
//     Prabhupada" because LLM never saw the canonical form)
//  4. LLM resolve over the prefiltered candidates
//  5. autoCreateDict if LLM finds nothing
//
// Returned `MatchedName` is the canonical name to persist in the
// metadata payload — full_name in `language` for author/location/tag,
// short_name for source. The id is also returned for legacy callers
// but the payload no longer stores it; commit re-looks-up name → id
// against the live catalog so manual catalog edits propagate.
func (uc UseCase) resolveOne(ctx context.Context, kind catalog.Kind, query, language string) (catalogport.ResolveResponse, error) {
	// 1. Exact match by canonical name. Cheap, no LLM, no fuzziness.
	if id, ok, err := uc.Catalog.LookupIDByName(ctx, kind, query, language); err == nil && ok {
		return catalogport.ResolveResponse{
			MatchedID:   id,
			MatchedName: query, // input matched the canonical name verbatim
			Confidence:  catalogport.ConfExact,
			Provider:    "exact",
		}, nil
	}

	// 2. In-process memo. Dedups LLM hits within MCP lifetime.
	mk := memoKey{kind: kind, query: query, language: language}.String()
	if v, ok := uc.runMemo.Load(mk); ok {
		m := v.(resolveMemo)
		return catalogport.ResolveResponse{
			MatchedID:   m.ID,
			MatchedName: m.Name,
			Confidence:  m.Confidence,
			Provider:    m.Provider + " (memo)",
			Reasoning:   m.Reasoning,
		}, nil
	}

	// 3. Trigram prefilter — feed only relevant candidates to the LLM.
	candidates, err := uc.fuzzyCandidates(ctx, kind, query, language)
	if err != nil {
		return catalogport.ResolveResponse{}, err
	}

	// 4. LLM resolve. The resolver returns matched_id; we map it to
	// the canonical name afterwards (so the payload stores name, not id).
	resp, err := uc.Resolver.Resolve(ctx, catalogport.ResolveRequest{
		Kind:       kind,
		Query:      query,
		Candidates: candidates,
		Hint:       language,
	})
	if err != nil {
		return catalogport.ResolveResponse{}, err
	}

	// Map LLM result to a canonical name we can persist.
	if resp.MatchedID != "" {
		// Backfill the missing locale (cheap exact-match path next time).
		if language != "" && kind != catalog.KindTag {
			uc.backfillLocaleIfMissing(ctx, kind, resp.MatchedID, language, query)
		}
		entry, ok, _ := uc.Catalog.GetDict(ctx, kind, resp.MatchedID)
		switch {
		case !ok:
			// Race: id vanished between LLM resolve and our GetDict (manual
			// catalog edit?). Fall through to autoCreate.
			resp.MatchedID = ""
		case kind == catalog.KindSource:
			if sn, ok := entry.ShortName[language]; ok && sn != "" {
				resp.MatchedName = sn
			} else {
				resp.MatchedName = query
			}
		default:
			if n, ok := entry.Names[language]; ok && n != "" {
				resp.MatchedName = n
			} else {
				resp.MatchedName = query
			}
		}
	}
	if resp.MatchedID == "" && uc.Minter != nil && query != "" && kind != catalog.KindTag {
		// 5. Auto-create with raw `query` as canonical name in this
		// language; translator (if any) fills the other locale.
		newID, err := uc.autoCreateDict(ctx, kind, query, language)
		if err != nil {
			return resp, err
		}
		resp = catalogport.ResolveResponse{
			MatchedID:   newID,
			MatchedName: query,
			Confidence:  catalogport.ConfHigh,
			Reasoning:   "no match found — created new dict entry",
			Provider:    "auto-create",
		}
	}

	// 6. Memo it — next file in this batch with the same raw string
	// short-circuits before any LLM call.
	if resp.MatchedID != "" {
		uc.runMemo.Store(mk, resolveMemo{
			ID:         resp.MatchedID,
			Name:       resp.MatchedName,
			Confidence: resp.Confidence,
			Provider:   resp.Provider,
			Reasoning:  resp.Reasoning,
		})
	}
	return resp, nil
}

// fuzzyCandidates returns the prefiltered list to hand the LLM. Falls
// back to ListDict(50) when the trigram index has nothing to offer
// (e.g. fresh empty catalog, or a query so unique it overlaps with
// nothing — LLM can still propose a structural match or, more often,
// confirm "no match".
func (uc UseCase) fuzzyCandidates(ctx context.Context, kind catalog.Kind, query, language string) ([]catalog.DictEntry, error) {
	if uc.FuzzyIndex != nil {
		hits, err := uc.FuzzyIndex.Match(ctx, kind, query, language, 0.20, 20)
		if err == nil && len(hits) > 0 {
			out := make([]catalog.DictEntry, 0, len(hits))
			for _, h := range hits {
				e, ok, err := uc.Catalog.GetDict(ctx, kind, h.ID)
				if err == nil && ok {
					out = append(out, e)
				}
			}
			if len(out) > 0 {
				return out, nil
			}
		}
	}
	// Fallback: top-50 by id order. Old behavior at smaller N (we used
	// to ship 200; 50 is plenty for an LLM whose job is "is the right
	// candidate already present").
	return uc.Catalog.ListDict(ctx, kind, catalog.ListOpts{Limit: 50})
}

// autoCreateDict mints a fresh ID and inserts one row per locale we serve.
// The translator (if configured) provides the canonical translations; any
// language it leaves blank is filled with `query` verbatim so the entry is
// guaranteed to have a row for every served language — a cross-locale file
// arriving later will exact-match instead of triggering a duplicate
// auto-create.
func (uc UseCase) autoCreateDict(ctx context.Context, kind catalog.Kind, query, language string) (string, error) {
	newID := kind.IDPrefix() + uc.Minter.MintTail()
	entry := catalog.DictEntry{
		Id:    newID,
		Names: map[string]string{language: query},
	}
	if kind == catalog.KindSource {
		entry.ShortName = map[string]string{language: query}
	}
	if uc.Translator != nil {
		if tr, err := uc.Translator.Translate(ctx, kind, query, language); err == nil {
			for lang, name := range tr.Names {
				if _, ok := entry.Names[lang]; !ok || lang != language {
					entry.Names[lang] = name
				}
			}
			if kind == catalog.KindSource {
				for lang, sn := range tr.ShortNames {
					if _, ok := entry.ShortName[lang]; !ok || lang != language {
						entry.ShortName[lang] = sn
					}
				}
			}
		}
	}
	// C2: ensure every served language has a row even when the translator
	// returned a partial map (or wasn't configured at all).
	for _, lang := range uc.servedLanguages() {
		if _, ok := entry.Names[lang]; !ok {
			entry.Names[lang] = query
		}
		if kind == catalog.KindSource {
			if _, ok := entry.ShortName[lang]; !ok {
				entry.ShortName[lang] = query
			}
		}
	}
	// Anchor the input language to `query` ONLY when nothing better is there.
	// For native queries (e.g. location "Бомбей") the slot already equals
	// `query` and this is a no-op. For canonical en-codes the parser injects
	// for sources ("BG"/"SB"/"CC") the translator returns the proper native
	// form ("Бхагавад-гита") and we keep it instead of clobbering back to the
	// abbreviation.
	if existing, ok := entry.Names[language]; !ok || existing == "" || existing == query {
		entry.Names[language] = query
	}
	if kind == catalog.KindSource {
		if existing, ok := entry.ShortName[language]; !ok || existing == "" || existing == query {
			entry.ShortName[language] = query
		}
	}
	if _, err := uc.Catalog.CreateDict(ctx, kind, entry); err != nil {
		return "", fmt.Errorf("auto-create %s %q: %w", kind, query, err)
	}
	return newID, nil
}

// servedLanguages returns the set of locales every dict entry should have
// a row in. Hardcoded to {ru, en} for now; the catalog `languages` table
// is the source of truth at the schema level but reading it on every
// auto-create would be wasteful when we ship just two.
func (uc UseCase) servedLanguages() []string {
	return []string{"ru", "en"}
}

// backfillLocaleIfMissing writes (id, language, query) into the matched
// dict entry when that locale was empty, so subsequent files in `language`
// resolve via the cheap exact resolver instead of repeatedly calling LLM.
func (uc UseCase) backfillLocaleIfMissing(ctx context.Context, kind catalog.Kind, id, language, query string) {
	entry, ok, err := uc.Catalog.GetDict(ctx, kind, id)
	if err != nil || !ok {
		return
	}
	if existing, ok := entry.Names[language]; ok && existing != "" {
		return
	}
	shortName := ""
	if kind == catalog.KindSource {
		shortName = query
	}
	_ = uc.Catalog.UpdateDictLocale(ctx, kind, id, language, query, shortName)
}

func (uc UseCase) entryLanguage(metaLangs []string) string {
	for _, l := range metaLangs {
		if l != "" {
			return l
		}
	}
	if uc.DefaultLanguage != "" {
		return uc.DefaultLanguage
	}
	return "ru"
}

// knownSourceShortNames builds a deduplicated list of source short_names to
// hand to the extractor as a hint.
func (uc UseCase) knownSourceShortNames(ctx context.Context) []string {
	if uc.Catalog == nil {
		return nil
	}
	entries, err := uc.Catalog.ListDict(ctx, catalog.KindSource, catalog.ListOpts{Limit: 500})
	if err != nil {
		return nil
	}
	seen := map[string]struct{}{}
	var out []string
	for _, e := range entries {
		for _, sn := range e.ShortName {
			if sn == "" {
				continue
			}
			if _, ok := seen[sn]; ok {
				continue
			}
			seen[sn] = struct{}{}
			out = append(out, sn)
		}
	}
	return out
}

func asResolve(kind, query string, r catalogport.ResolveResponse) Resolve {
	return Resolve{
		Kind:       kind,
		Query:      query,
		MatchedID:  r.MatchedID,
		Confidence: string(r.Confidence),
		Provider:   r.Provider,
		Reasoning:  r.Reasoning,
	}
}

func atomicWrite(path string, body []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// avoid unused import in extreme cases
var _ = time.RFC3339
