package outline

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	openaicompatoutline "github.com/jiva-studio/lectorium/pipeline/outline/openaicompat"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	pipelineoutline "github.com/jiva-studio/lectorium/pipeline/outline"
)

// The batch path trades latency for half the price: one request per lecture
// goes to the provider's batch endpoint and the replies arrive within a day.
//
// It skips the LLM merge pass the synchronous path runs. That pass exists to
// give a grouped chapter a title covering the whole group, and it costs a
// second round trip per lecture — which a batch cannot do without a second
// 24-hour window. Collapsing locally is what the synchronous path already falls
// back to when the merge fails, so the shape of the result is the same.

// Batcher is the job API the batch path needs. Same surface as the review one;
// the adapter over the Gemini client satisfies both.
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

// Done reports whether the job stopped moving — not that the requests inside
// it worked. A job reports success with every one of them failed.
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

// BatchRecord is what Submit persists so Collect knows which lectures a job
// covers without asking the provider.
type BatchRecord struct {
	Name        string    `json:"name"`
	Language    string    `json:"language"`
	SubmittedAt time.Time `json:"submitted_at"`
	Tracks      []string  `json:"tracks"`
}

// BatchStore persists job records between submit and collect, which may be
// hours and a restart apart.
type BatchStore struct {
	Dir string
}

func NewBatchStore(outDir string) *BatchStore {
	return &BatchStore{Dir: filepath.Join(outDir, "artifacts", "lake", "outline-batches")}
}

func (s *BatchStore) path(name string) string {
	safe := strings.ReplaceAll(strings.TrimPrefix(name, "batches/"), "/", "_")
	return filepath.Join(s.Dir, safe+".json")
}

func (s *BatchStore) Save(rec BatchRecord) error {
	if rec.Name == "" {
		return fmt.Errorf("outline batch store: record without a job name")
	}
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	p := s.path(rec.Name)
	if err := os.WriteFile(p+".tmp", body, 0o644); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

func (s *BatchStore) Load(name string) (BatchRecord, error) {
	body, err := os.ReadFile(s.path(name))
	if err != nil {
		return BatchRecord{}, err
	}
	var rec BatchRecord
	return rec, json.Unmarshal(body, &rec)
}

func (s *BatchStore) List() ([]BatchRecord, error) {
	entries, err := os.ReadDir(s.Dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]BatchRecord, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(s.Dir, e.Name()))
		if err != nil {
			continue
		}
		var rec BatchRecord
		if json.Unmarshal(body, &rec) == nil {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SubmittedAt.After(out[j].SubmittedAt) })
	return out, nil
}

type SubmitBatchResult struct {
	Name     string   `json:"name"`
	Language string   `json:"language"`
	Tracks   []string `json:"tracks"`
	Skipped  []string `json:"skipped,omitempty"`
}

// SubmitBatch queues one request per lecture: the whole transcript, compressed,
// against the same prompt the synchronous path uses.
func (uc UseCase) SubmitBatch(ctx context.Context, ids []track.ID, language string) (SubmitBatchResult, error) {
	if uc.Batch == nil || uc.BatchJobs == nil {
		return SubmitBatchResult{}, fmt.Errorf("outline batch path is not configured")
	}
	reqs := make([]BatchRequest, 0, len(ids))
	covered := make([]string, 0, len(ids))
	var skipped []string
	for _, id := range ids {
		rev, err := uc.Transcripts.ReadReviewed(ctx, id, language)
		if err != nil {
			skipped = append(skipped, string(id))
			continue
		}
		text, _, _ := pipelineoutline.LectureText(rev.Blocks, uc.Compress)
		if strings.TrimSpace(text) == "" {
			skipped = append(skipped, string(id))
			continue
		}
		reqs = append(reqs, BatchRequest{
			Key:         string(id),
			System:      openaicompatoutline.PassPrompt(language),
			User:        text,
			Temperature: 0.2,
			MaxTokens:   uc.batchMaxTokens(),
		})
		covered = append(covered, string(id))
	}
	if len(reqs) == 0 {
		return SubmitBatchResult{}, fmt.Errorf("outline batch: nothing to submit (%d tracks had no reviewed transcript)", len(skipped))
	}

	name, err := uc.Batch.Submit(ctx, fmt.Sprintf("lectorium-outline-%s", language), reqs)
	if err != nil {
		return SubmitBatchResult{}, err
	}
	rec := BatchRecord{Name: name, Language: language, SubmittedAt: uc.Clock.Now().UTC(), Tracks: covered}
	if err := uc.BatchJobs.Save(rec); err != nil {
		return SubmitBatchResult{}, fmt.Errorf("outline batch: job %s submitted but not recorded: %w", name, err)
	}
	return SubmitBatchResult{Name: name, Language: language, Tracks: covered, Skipped: skipped}, nil
}

// batchMaxTokens leaves room for a granular list plus the description. The
// synchronous ceiling is sized for one pass at a time; a batch reply carries
// both halves and cannot be retried cheaply, so it gets a wider budget.
func (uc UseCase) batchMaxTokens() int {
	if uc.MaxTokens >= minBatchMaxTokens {
		return uc.MaxTokens
	}
	return minBatchMaxTokens
}

const minBatchMaxTokens = 4096

type CollectTrack struct {
	TrackID  string `json:"track_id"`
	Chapters int    `json:"chapters"`
	Error    string `json:"error,omitempty"`
}

type CollectBatchResult struct {
	Name       string         `json:"name"`
	State      string         `json:"state"`
	Successful int            `json:"successful"`
	Failed     int            `json:"failed"`
	Missing    []string       `json:"missing,omitempty"`
	Tracks     []CollectTrack `json:"tracks"`
}

// CollectBatch turns a finished job into stored outlines. A lecture the job
// dropped is reported under Missing rather than silently absent — a failed
// request simply does not come back.
func (uc UseCase) CollectBatch(ctx context.Context, name string) (CollectBatchResult, error) {
	if uc.Batch == nil || uc.BatchJobs == nil {
		return CollectBatchResult{}, fmt.Errorf("outline batch path is not configured")
	}
	rec, err := uc.BatchJobs.Load(name)
	if err != nil {
		return CollectBatchResult{}, fmt.Errorf("outline batch: unknown job %s: %w", name, err)
	}
	job, results, err := uc.Batch.Fetch(ctx, name)
	if err != nil {
		return CollectBatchResult{}, err
	}
	if !job.Done() {
		return CollectBatchResult{}, fmt.Errorf("outline batch: job %s is still %s", name, job.State)
	}

	out := CollectBatchResult{Name: name, State: job.State,
		Successful: job.Successful, Failed: job.Failed}
	got := make(map[string]bool, len(results))
	for _, r := range results {
		got[r.Key] = true
		ct := CollectTrack{TrackID: r.Key}
		if r.Err != nil {
			ct.Error = r.Err.Error()
			out.Tracks = append(out.Tracks, ct)
			continue
		}
		n, err := uc.storeFromReply(ctx, track.ID(r.Key), rec.Language, r.Text)
		if err != nil {
			ct.Error = err.Error()
		}
		ct.Chapters = n
		out.Tracks = append(out.Tracks, ct)
	}
	for _, id := range rec.Tracks {
		if !got[id] {
			out.Missing = append(out.Missing, id)
		}
	}
	return out, nil
}

// storeFromReply parses one batch reply and writes it exactly where the
// synchronous path writes: the coarse outline and description onto the catalog
// variant, the granular list as a private artifact.
func (uc UseCase) storeFromReply(ctx context.Context, id track.ID, language, raw string) (int, error) {
	rev, err := uc.Transcripts.ReadReviewed(ctx, id, language)
	if err != nil {
		return 0, fmt.Errorf("read reviewed transcript: %w", err)
	}
	items, desc, err := openaicompatoutline.ParsePass(raw)
	if err != nil {
		return 0, err
	}
	res := pipelineoutline.Assemble(rev.Blocks, uc.Compress, items, items, desc)
	if err := uc.write(ctx, id, language, res); err != nil {
		return 0, err
	}
	return len(res.Coarse), nil
}
