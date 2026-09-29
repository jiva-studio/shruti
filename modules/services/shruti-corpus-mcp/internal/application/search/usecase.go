// Package search plans and runs one corpus search: it maps the requested
// result types onto chunk kinds, narrows recall to the tracks citing a
// reference when only tracks are wanted, retrieves over both hybrid lanes, and
// applies the attribute filters the lanes cannot, reading every track the hits
// name in one batch.
package search

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/domain/corpus"
)

// Embedder turns a query into its embedding.
type Embedder interface {
	Query(ctx context.Context, text string) ([]float32, error)
}

// Retriever runs the fused vector + lexical retrieval. trackIDs, when set,
// restricts both lanes to chunks of those tracks.
type Retriever interface {
	Hybrid(ctx context.Context, query string, vec []float32, kinds []string, lang string,
		limit int, trgmMinSim float64, trackIDs []string) ([]corpus.Chunk, corpus.LaneTimings, error)
}

// Tracks reads the catalog side of track hits.
type Tracks interface {
	// TrackIDsByRef returns the tracks citing a source, at a position or
	// anywhere under it.
	TrackIDsByRef(ctx context.Context, sourceID, tokens string) ([]string, error)
	// GetTracks returns the visible tracks among ids, references included.
	GetTracks(ctx context.Context, ids []string) (map[string]*corpus.Track, error)
}

// UseCase is the search planner.
type UseCase struct {
	Embed      Embedder
	Retrieve   Retriever
	Tracks     Tracks
	TrgmMinSim float64
}

// Request is one search. SourceID is already resolved from what the caller
// typed; Tokens is already normalised and set only with SourceID.
type Request struct {
	Query      string
	Types      []string
	SourceID   string
	Tokens     string
	Kind       string
	AuthorID   string
	LocationID string
	DateFrom   string
	DateTo     string
	Lang       string
	Limit      int
	MinScore   float64
}

// Hit is a kept chunk; Track is set for a track hit.
type Hit struct {
	Chunk corpus.Chunk
	Track *corpus.Track
}

// Result is what a search found. Retrieved is false when the plan proved
// there could be no hit without running the lanes.
type Result struct {
	Hits      []Hit
	Lanes     corpus.LaneTimings
	Retrieved bool
}

// ErrInvalidArgument marks a request the caller has to change.
var ErrInvalidArgument = errors.New("invalid argument")

// InvalidTypeError names a result type search does not know.
type InvalidTypeError struct{ Type string }

func (e InvalidTypeError) Error() string { return "invalid type: " + e.Type }

// Is makes an InvalidTypeError an ErrInvalidArgument.
func (e InvalidTypeError) Is(target error) bool { return target == ErrInvalidArgument }

// DependencyError is a failure of the embedder or the retrieval backend.
type DependencyError struct {
	What string
	Err  error
}

func (e *DependencyError) Error() string {
	if e.What == "" {
		return e.Err.Error()
	}
	return e.What + ": " + e.Err.Error()
}

func (e *DependencyError) Unwrap() error { return e.Err }

// Run plans and executes a search.
func (uc UseCase) Run(ctx context.Context, req Request) (Result, error) {
	kinds, err := ChunkKindsForTypes(req.Types)
	if err != nil {
		return Result{}, err
	}
	if IsDocKind(req.Kind) {
		kinds = keepDocKind(kinds, req.Kind)
	}

	// Track-only search under a reference: resolve the citing tracks up front
	// and push them into the lanes, so recall only touches relevant chunks.
	trackOnly := len(kinds) == 1 && kinds[0] == "track_transcript"
	refPrefiltered := trackOnly && req.SourceID != ""
	var trackIDs []string
	if refPrefiltered {
		if trackIDs, err = uc.Tracks.TrackIDsByRef(ctx, req.SourceID, req.Tokens); err != nil {
			return Result{}, fmt.Errorf("tracks citing %s %s: %w", req.SourceID, req.Tokens, err)
		}
		if len(trackIDs) == 0 {
			return Result{}, nil
		}
	}

	vec, err := uc.Embed.Query(ctx, req.Query)
	if err != nil {
		return Result{}, &DependencyError{What: "embed query", Err: err}
	}
	chunks, lanes, err := uc.Retrieve.Hybrid(ctx, req.Query, vec, kinds, req.Lang,
		retrieveSize(req, refPrefiltered), uc.TrgmMinSim, trackIDs)
	if err != nil {
		return Result{}, &DependencyError{Err: err}
	}

	tracks, err := uc.Tracks.GetTracks(ctx, trackIDsOf(chunks))
	if err != nil {
		return Result{}, fmt.Errorf("read hit tracks: %w", err)
	}
	f := filter{req: req, refPrefiltered: refPrefiltered}
	hits := make([]Hit, 0, req.Limit)
	for _, c := range chunks {
		if len(hits) >= req.Limit {
			break
		}
		if c.Score < req.MinScore {
			continue
		}
		if h, keep := f.apply(c, tracks); keep {
			hits = append(hits, h)
		}
	}
	return Result{Hits: hits, Lanes: lanes, Retrieved: true}, nil
}

// retrieveSize over-fetches when a filter will drop hits after retrieval —
// except under the reference pre-filter, which already narrows recall.
func retrieveSize(req Request, refPrefiltered bool) int {
	hasPostFilter := req.SourceID != "" || req.Tokens != "" || req.Kind != "" ||
		req.AuthorID != "" || req.LocationID != "" || req.DateFrom != "" || req.DateTo != ""
	if !hasPostFilter || refPrefiltered {
		return req.Limit
	}
	return min(max(req.Limit*8, 50), 200)
}

func trackIDsOf(chunks []corpus.Chunk) []string {
	seen := map[string]bool{}
	var ids []string
	for _, c := range chunks {
		if c.Kind != "track_transcript" {
			continue
		}
		if id := corpus.Deref(c.TrackID); id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids
}

// filter applies the attribute filters the lanes do not.
type filter struct {
	req            Request
	refPrefiltered bool
}

func (f filter) apply(c corpus.Chunk, tracks map[string]*corpus.Track) (Hit, bool) {
	r := f.req
	switch c.Kind {
	case "verse", "commentary", "prose_chapter", "letter", "title":
		// Library hit: source/tokens apply; kind and author only to documents;
		// the track-only filters exclude it.
		if r.SourceID != "" && corpus.Deref(c.SourceID) != r.SourceID {
			return Hit{}, false
		}
		if r.Tokens != "" && corpus.Deref(c.Tokens) != r.Tokens {
			return Hit{}, false
		}
		if r.LocationID != "" || r.DateFrom != "" || r.DateTo != "" {
			return Hit{}, false
		}
		if c.Kind == "verse" || c.Kind == "title" {
			if r.Kind != "" || r.AuthorID != "" {
				return Hit{}, false
			}
		} else {
			if r.Kind != "" && c.Kind != r.Kind {
				return Hit{}, false
			}
			if r.AuthorID != "" && corpus.Deref(c.AuthorID) != r.AuthorID {
				return Hit{}, false
			}
		}
		return Hit{Chunk: c}, true

	case "track_transcript":
		tr := tracks[corpus.Deref(c.TrackID)]
		if tr == nil {
			return Hit{}, false // hidden or removed track
		}
		if (r.AuthorID != "" && tr.AuthorID != r.AuthorID) ||
			(r.LocationID != "" && tr.LocationID != r.LocationID) ||
			(r.DateFrom != "" && tr.Date < r.DateFrom) ||
			(r.DateTo != "" && tr.Date > r.DateTo) ||
			(r.Kind != "" && tr.Kind() != r.Kind) {
			return Hit{}, false
		}
		// Recall pre-filtered to citing tracks already applied the
		// chapter-prefix rule; an exact check would drop those hits.
		if r.SourceID != "" && !f.refPrefiltered && !tr.Cites(r.SourceID, r.Tokens) {
			return Hit{}, false
		}
		return Hit{Chunk: c, Track: tr}, true

	case "media":
		// A media clip carries none of the library or track attributes, so
		// any of those filters excludes it.
		if r.SourceID != "" || r.Tokens != "" || r.Kind != "" || r.AuthorID != "" ||
			r.LocationID != "" || r.DateFrom != "" || r.DateTo != "" || corpus.Deref(c.ItemID) == "" {
			return Hit{}, false
		}
		return Hit{Chunk: c}, true
	}
	return Hit{}, false
}

// ChunkKindsForTypes maps the public result types onto chunk kinds; no types
// means every kind.
func ChunkKindsForTypes(types []string) ([]string, error) {
	if len(types) == 0 {
		return []string{"verse", "commentary", "prose_chapter", "letter", "track_transcript", "title", "media"}, nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(kinds ...string) {
		for _, k := range kinds {
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	for _, t := range types {
		switch strings.ToLower(strings.TrimSpace(t)) {
		case "verse":
			add("verse")
		case "document":
			add("commentary", "prose_chapter", "letter")
		case "track":
			add("track_transcript")
		case "title":
			add("title")
		case "media":
			add("media")
		case "":
		default:
			return nil, InvalidTypeError{Type: t}
		}
	}
	return out, nil
}

// IsDocKind reports whether k is a document chunk kind.
func IsDocKind(k string) bool {
	switch k {
	case "commentary", "prose_chapter", "letter":
		return true
	}
	return false
}

// keepDocKind drops every document kind but keep.
func keepDocKind(kinds []string, keep string) []string {
	var out []string
	for _, k := range kinds {
		if IsDocKind(k) && k != keep {
			continue
		}
		out = append(out, k)
	}
	return out
}
