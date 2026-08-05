package review

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	pipelinereview "github.com/jiva-studio/shruti/pipeline/review"
	openaicompatreview "github.com/jiva-studio/shruti/pipeline/review/openaicompat"
)

// The batch path trades latency for half the price: chunks go to a job that
// finishes within 24 hours instead of a live call. Collect writes the replies
// as ordinary chunk artifacts and then runs the normal review, which reuses
// what is on disk and reviews the rest live — so a chunk the job dropped or
// failed is caught up in the same pass rather than waiting another window.

// Batcher is the job API the batch path needs.
type Batcher interface {
	Submit(ctx context.Context, displayName string, reqs []BatchRequest) (string, error)
	Fetch(ctx context.Context, name string) (BatchJob, []BatchResult, error)
}

type BatchRequest struct {
	Key         string
	System      string
	User        string
	Temperature float64
	MaxTokens   int
}

type BatchJob struct {
	Name       string
	State      string
	Total      int
	Successful int
	Failed     int
}

// Done reports whether the job stopped moving. It is not a claim that the
// requests inside it worked — a job reports success with every one failed.
func (j BatchJob) Done() bool {
	return j.State != "" && j.State != "BATCH_STATE_PENDING" && j.State != "BATCH_STATE_RUNNING"
}

type BatchResult struct {
	Key       string
	Text      string
	Err       error
	TokensIn  int64
	TokensOut int64
}

// BatchRecord is what Submit persists so Collect can rebuild the same chunks.
type BatchRecord struct {
	Name        string         `json:"name"`
	Language    string         `json:"language"`
	ChunkSize   int            `json:"chunk_size"`
	Overlap     int            `json:"overlap"`
	SubmittedAt time.Time      `json:"submitted_at"`
	Tracks      map[string]int `json:"tracks"` // track id -> chunk count
}

// BatchStore persists job records between submit and collect.
type BatchStore interface {
	Save(ctx context.Context, rec BatchRecord) error
	Load(ctx context.Context, name string) (BatchRecord, error)
	List(ctx context.Context) ([]BatchRecord, error)
}

type SubmitBatchResult struct {
	Name     string         `json:"name"`
	Language string         `json:"language"`
	Chunks   int            `json:"chunks"`
	Tracks   map[string]int `json:"tracks"`
}

// SubmitBatch queues every chunk of the given tracks as one job.
func (uc UseCase) SubmitBatch(ctx context.Context, ids []track.Id, language string, opts Options) (SubmitBatchResult, error) {
	if uc.Batch == nil || uc.BatchJobs == nil {
		return SubmitBatchResult{}, fmt.Errorf("review: batch path is not configured (set review.batch in config)")
	}
	if len(ids) == 0 {
		return SubmitBatchResult{}, fmt.Errorf("review: no tracks to submit")
	}
	chunkSize, overlap := uc.chunkParams(opts)

	var reqs []BatchRequest
	tracks := map[string]int{}
	for _, id := range ids {
		raw, err := uc.Transcripts.ReadRaw(ctx, id, language)
		if err != nil {
			return SubmitBatchResult{}, fmt.Errorf("review: read raw %s: %w", id, err)
		}
		segs := uc.filterNoise(raw.Segments)
		chunks := pipelinereview.BuildChunks(segs, chunkSize, overlap)
		tracks[string(id)] = len(chunks)
		for i, ch := range chunks {
			req := uc.chunkRequest(language, chunks, i, ch.Segs)
			reqs = append(reqs, BatchRequest{
				Key:         batchKey(id, i),
				System:      openaicompatreview.LinesSystemPrompt,
				User:        openaicompatreview.BuildUserPrompt(uc.batchUserPrompt(), req),
				Temperature: 0.1,
				MaxTokens:   uc.BatchMaxTokens,
			})
		}
	}
	if len(reqs) == 0 {
		return SubmitBatchResult{}, fmt.Errorf("review: nothing to submit — no chunks")
	}

	name, err := uc.Batch.Submit(ctx, fmt.Sprintf("shruti-review-%s", language), reqs)
	if err != nil {
		return SubmitBatchResult{}, err
	}
	rec := BatchRecord{
		Name: name, Language: language,
		ChunkSize: chunkSize, Overlap: overlap,
		SubmittedAt: time.Now().UTC(), Tracks: tracks,
	}
	if err := uc.BatchJobs.Save(ctx, rec); err != nil {
		return SubmitBatchResult{}, fmt.Errorf("review: job %s submitted but not recorded: %w", name, err)
	}
	return SubmitBatchResult{Name: name, Language: language, Chunks: len(reqs), Tracks: tracks}, nil
}

type CollectTrack struct {
	TrackId   string `json:"track_id"`
	FromBatch int    `json:"from_batch"`
	Live      int    `json:"live"`
	Blocks    int    `json:"blocks"`
	Error     string `json:"error,omitempty"`
}

type CollectBatchResult struct {
	Name       string         `json:"name"`
	State      string         `json:"state"`
	Successful int            `json:"successful"`
	Failed     int            `json:"failed"`
	Missing    []string       `json:"missing,omitempty"`
	Tracks     []CollectTrack `json:"tracks"`
}

// CollectBatch turns a finished job into reviewed transcripts. Replies land as
// chunk artifacts; the normal review then runs per track, reusing them and
// paying live only for whatever the job did not deliver.
func (uc UseCase) CollectBatch(ctx context.Context, name string, opts Options) (CollectBatchResult, error) {
	if uc.Batch == nil || uc.BatchJobs == nil {
		return CollectBatchResult{}, fmt.Errorf("review: batch path is not configured")
	}
	rec, err := uc.BatchJobs.Load(ctx, name)
	if err != nil {
		return CollectBatchResult{}, err
	}
	job, results, err := uc.Batch.Fetch(ctx, name)
	if err != nil {
		return CollectBatchResult{}, err
	}
	out := CollectBatchResult{Name: job.Name, State: job.State,
		Successful: job.Successful, Failed: job.Failed}

	byTrack := map[string]map[int]BatchResult{}
	for _, r := range results {
		id, idx, ok := parseBatchKey(r.Key)
		if !ok {
			continue
		}
		if byTrack[id] == nil {
			byTrack[id] = map[int]BatchResult{}
		}
		byTrack[id][idx] = r
	}

	ids := make([]string, 0, len(rec.Tracks))
	for id := range rec.Tracks {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for _, id := range ids {
		total := rec.Tracks[id]
		got := byTrack[id]
		written := 0
		for i := 0; i < total; i++ {
			r, ok := got[i]
			if !ok {
				out.Missing = append(out.Missing, batchKey(track.Id(id), i))
				continue
			}
			if r.Err != nil {
				continue // left for the live pass
			}
			if err := uc.persistBatchChunk(ctx, track.Id(id), rec, i, r); err == nil {
				written++
			}
		}
		ct := CollectTrack{TrackId: id, FromBatch: written, Live: total - written}
		// Reuses the artifacts just written; anything absent is reviewed live.
		res, err := uc.Run(ctx, track.Id(id), rec.Language, Options{
			ChunkSize: rec.ChunkSize, Overlap: rec.Overlap,
			Concurrency: opts.Concurrency, Method: "llm",
		})
		if err != nil {
			ct.Error = err.Error()
		} else {
			ct.Blocks = res.Blocks
		}
		out.Tracks = append(out.Tracks, ct)
	}
	return out, nil
}

// persistBatchChunk stores a job reply in the same shape a live call would, so
// the normal review picks it up without knowing where it came from.
func (uc UseCase) persistBatchChunk(ctx context.Context, id track.Id, rec BatchRecord, idx int, r BatchResult) error {
	raw, err := uc.Transcripts.ReadRaw(ctx, id, rec.Language)
	if err != nil {
		return err
	}
	segs := uc.filterNoise(raw.Segments)
	chunks := pipelinereview.BuildChunks(segs, rec.ChunkSize, rec.Overlap)
	if idx >= len(chunks) {
		return fmt.Errorf("review: chunk %d is outside %s", idx, id)
	}
	req := uc.chunkRequest(rec.Language, chunks, idx, chunks[idx].Segs)
	corrected, sentences, err := openaicompatreview.ParseLines(r.Text, req.Segments)
	if err != nil {
		return err
	}
	att := pipelinereview.ChunkAttempt{Final: reviewport.ChunkResponse{
		Segments:  corrected,
		Sentences: sentences,
		Models: []reviewport.ModelEntry{{
			Role: "batch", Name: uc.BatchModel, ModelID: uc.BatchModel,
			TokensIn: r.TokensIn, TokensOut: r.TokensOut,
			CostUSD: uc.batchCost(r.TokensIn, r.TokensOut),
		}},
	}}
	now := time.Now().UTC()
	persistChunkArtifact(ctx, uc.Transcripts, id, rec.Language, idx, chunks[idx].Segs, req, att, now, now)
	return nil
}

// batchCost prices a reply from the configured rates. The API returns tokens
// only, so an unset rate yields no cost rather than a guess.
func (uc UseCase) batchCost(in, out int64) float64 {
	return float64(in)/1e6*uc.BatchPriceIn + float64(out)/1e6*uc.BatchPriceOut
}

func batchKey(id track.Id, idx int) string { return string(id) + ":" + strconv.Itoa(idx) }

func parseBatchKey(k string) (string, int, bool) {
	i := strings.LastIndex(k, ":")
	if i <= 0 {
		return "", 0, false
	}
	idx, err := strconv.Atoi(k[i+1:])
	if err != nil {
		return "", 0, false
	}
	return k[:i], idx, true
}
