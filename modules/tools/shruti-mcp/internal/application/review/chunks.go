package review

import (
	"context"
	"errors"
	"sync"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	pipelinereview "github.com/jiva-studio/shruti/pipeline/review"
)

// chunkRun is one track's chunks and how to review them.
type chunkRun struct {
	id          track.ID
	language    string
	chunks      []pipelinereview.Chunk
	overlap     int
	concurrency int
	reviewers   []reviewport.Reviewer
	opts        Options
}

// chunkResult is one chunk's outcome. A chunk that could not be reviewed
// carries its idx in fallback and keeps the raw text.
type chunkResult struct {
	segs      []reviewport.ChunkSegment
	sentences [][]int // raw idx grouped into sentences
	fallback  []int
}

// reviewChunks reviews every chunk, concurrency at a time.
//
// A chunk with a successful artifact on disk is reused, so a run cut short by
// a timeout does not pay twice for finished chunks; ForceFullRerun reviews
// them again. OnlyChunks restricts the run to the listed chunks: the others
// reuse their artifact, or fall back to the raw text when they have none,
// and ForceFullRerun applies only inside the list.
func (uc UseCase) reviewChunks(ctx context.Context, run chunkRun) ([]chunkResult, error) {
	retries := max(uc.Retries, 0)
	only := map[int]bool{}
	for _, idx := range run.opts.OnlyChunks {
		only[idx] = true
	}

	results := make([]chunkResult, len(run.chunks))
	errs := make([]error, len(run.chunks))
	sem := make(chan struct{}, run.concurrency)
	var wg sync.WaitGroup
	for i := range run.chunks {
		tryDisk := !run.opts.ForceFullRerun || (len(only) > 0 && !only[i])
		if tryDisk {
			if reused, ok := loadSucceededChunk(ctx, uc.Transcripts, run.id, run.language, i); ok {
				results[i] = chunkResult{segs: reused.Response.Segments, sentences: reused.Response.Sentences}
				continue
			}
		}
		if len(only) > 0 && !only[i] {
			results[i] = chunkResult{fallback: chunkIdx(run.chunks[i])}
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			results[i], errs[i] = uc.reviewChunk(ctx, run, i, retries)
		}()
	}
	wg.Wait()
	return results, errors.Join(errs...)
}

// reviewChunk walks the attempt chain for one chunk: on an audit or idx-set
// failure the next attempt runs. The models of every superseded attempt are
// kept in the chunk artifact, so its cost and history are complete, and the
// artifact is written even for a chunk that fell back so the failure can be
// inspected.
func (uc UseCase) reviewChunk(ctx context.Context, run chunkRun, i, retries int) (chunkResult, error) {
	req := uc.chunkRequest(run.language, run.chunks, i, run.overlap)
	startedAt := uc.Clock.Now().UTC()
	var (
		attempt  pipelinereview.ChunkAttempt
		rejected []reviewport.ModelEntry
	)
	for _, reviewer := range run.reviewers {
		attempt = pipelinereview.TryReview(ctx, reviewer, req, retries)
		if attempt.Err == nil {
			break
		}
		rejected = append(rejected, pipelinereview.TagOutcome(attempt.Final.Models,
			reviewport.OutcomeAttemptSuperseded, nil, attempt.Err.Error())...)
	}
	if len(rejected) > 0 {
		attempt.Final.Models = append(append([]reviewport.ModelEntry{}, rejected...), attempt.Final.Models...)
	}
	finishedAt := uc.Clock.Now().UTC()

	if err := persistChunkArtifact(ctx, uc.Transcripts, run.id, run.language, i,
		run.chunks[i].Segs, req, attempt, startedAt, finishedAt); err != nil {
		return chunkResult{}, err
	}
	if attempt.Err == nil {
		return chunkResult{segs: attempt.Final.Segments, sentences: attempt.Final.Sentences}, nil
	}
	// Every attempt failed: the chunk keeps its raw text, and the failure is in
	// its artifact.
	return chunkResult{fallback: chunkIdx(run.chunks[i])}, nil
}

func chunkIdx(ck pipelinereview.Chunk) []int {
	out := make([]int, 0, len(ck.Segs))
	for _, s := range ck.Segs {
		out = append(out, s.Idx)
	}
	return out
}
