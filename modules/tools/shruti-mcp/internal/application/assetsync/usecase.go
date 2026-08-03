// Package assetsync uploads the files under out/public/ to the publish targets.
//
// It is resumable by construction rather than by bookkeeping: the decision to
// upload is taken per file against the target itself, so an interrupted run
// re-run picks up exactly what is still missing. That matters at this scale —
// the corpus is hundreds of gigabytes over a link that does drop.
package assetsync

import (
	"context"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	assetsport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/assets"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

type UseCase struct {
	OutDir   string
	Targets  []s3port.Uploader
	Registry lakeport.Registry
}

type Options struct {
	// Prefix limits the walk to a subtree of out/, e.g. "public/tracks".
	Prefix string
	// TrackIds limits the walk to these tracks' assets. Empty = no filter.
	TrackIds []string
	// Decider chooses what needs uploading; nil means size-match.
	Decider assetsport.Decider
	// Concurrency is the number of files in flight per target.
	Concurrency int
	// Limit caps how many files one run uploads. 0 = no cap.
	Limit int
	// DryRun reports the plan and uploads nothing.
	DryRun bool
	// All considers tracks already marked published. Off by default: the
	// registry remembers what reached the target, so a routine run asks about
	// new tracks only instead of re-probing thousands of unchanged files.
	All bool
}

type TargetResult struct {
	Target        string   `json:"target"`
	Considered    int      `json:"considered"`
	Uploaded      int      `json:"uploaded"`
	Skipped       int      `json:"skipped"`
	Failed        int      `json:"failed"`
	BytesUploaded int64    `json:"bytes_uploaded"`
	BytesPending  int64    `json:"bytes_pending,omitempty"`
	Errors        []string `json:"errors,omitempty"`
}

type Result struct {
	Strategy string         `json:"strategy"`
	DryRun   bool           `json:"dry_run,omitempty"`
	Files    int            `json:"files_seen"`
	Bytes    int64          `json:"bytes_seen"`
	Skipped  int            `json:"tracks_already_published,omitempty"`
	Marked   int            `json:"tracks_marked_published,omitempty"`
	Targets  []TargetResult `json:"targets"`
}

// Run walks the local asset tree once and syncs it to every target.
func (uc UseCase) Run(ctx context.Context, opts Options) (Result, error) {
	if len(uc.Targets) == 0 {
		return Result{}, fmt.Errorf("assetsync: no publish targets configured")
	}
	dec := opts.Decider
	if dec == nil {
		return Result{}, fmt.Errorf("assetsync: no strategy")
	}
	files, err := uc.walk(opts)
	if err != nil {
		return Result{}, err
	}

	res := Result{Strategy: dec.Name(), DryRun: opts.DryRun}
	byTrack := groupByTrack(files)
	todo := make([]assetsport.File, 0, len(files))
	for id, group := range byTrack {
		if !opts.All && uc.isPublished(ctx, id) {
			res.Skipped++
			continue
		}
		todo = append(todo, group...)
	}
	sort.Slice(todo, func(i, j int) bool { return todo[i].Key < todo[j].Key })

	res.Files = len(todo)
	for _, f := range todo {
		res.Bytes += f.Size
	}
	held := make([]map[string]bool, 0, len(uc.Targets))
	for _, t := range uc.Targets {
		r, holds := uc.syncOne(ctx, t, dec, todo, opts)
		res.Targets = append(res.Targets, r)
		held = append(held, holds)
	}

	// A track counts as published once every target holds all of its files —
	// whether this run put them there or found them already in place, which is
	// what backfills a corpus published before the stage existed.
	if !opts.DryRun {
		res.Marked = uc.markPublished(ctx, byTrack, held, opts)
	}
	return res, nil
}

func (uc UseCase) isPublished(ctx context.Context, id string) bool {
	if uc.Registry == nil {
		return false
	}
	row, ok, err := uc.Registry.GetStage(ctx, track.Id(id),
		pipeline.Key{Stage: pipeline.StagePublished})
	return err == nil && ok && row.Status == pipeline.StatusDone
}

// markPublished records the stage for tracks every target was confirmed to
// hold in full during this run. A track with even one file unaccounted for
// stays unmarked, so the next run picks it up again.
func (uc UseCase) markPublished(ctx context.Context, byTrack map[string][]assetsport.File,
	held []map[string]bool, opts Options) int {
	if uc.Registry == nil || len(held) == 0 {
		return 0
	}
	marked := 0
	for id, group := range byTrack {
		ok := true
		for _, holds := range held {
			for _, f := range group {
				if !holds[f.Key] {
					ok = false
					break
				}
			}
			if !ok {
				break
			}
		}
		if !ok {
			continue
		}
		key := pipeline.Key{Stage: pipeline.StagePublished}
		if err := uc.Registry.SetStage(ctx, track.Id(id), key, pipeline.StatusDone, nil, ""); err == nil {
			marked++
		}
	}
	return marked
}

// groupByTrack buckets assets under public/tracks/<id>/ by their track.
func groupByTrack(files []assetsport.File) map[string][]assetsport.File {
	out := map[string][]assetsport.File{}
	for _, f := range files {
		parts := strings.Split(f.Key, "/")
		id := ""
		for i, p := range parts {
			if p == "tracks" && i+1 < len(parts) {
				id = parts[i+1]
				break
			}
		}
		out[id] = append(out[id], f)
	}
	return out
}

// syncOne returns its counters plus the keys this target is known to hold
// afterwards — either found already in place or just uploaded. Reusing that
// knowledge is what keeps the run to one probe per file instead of two.
func (uc UseCase) syncOne(ctx context.Context, target s3port.Uploader,
	dec assetsport.Decider, files []assetsport.File, opts Options) (TargetResult, map[string]bool) {

	workers := opts.Concurrency
	if workers <= 0 {
		workers = 4
	}
	var (
		mu       sync.Mutex
		out      = TargetResult{Target: target.Name(), Considered: len(files)}
		holds    = map[string]bool{}
		uploaded int64
		jobs     = make(chan assetsport.File)
		wg       sync.WaitGroup
	)

	worker := func() {
		defer wg.Done()
		for f := range jobs {
			if ctx.Err() != nil {
				return
			}
			need, _, err := dec.Needs(ctx, target, f)
			if err != nil {
				mu.Lock()
				out.Failed++
				if len(out.Errors) < 10 {
					out.Errors = append(out.Errors, fmt.Sprintf("%s: head: %v", f.Key, err))
				}
				mu.Unlock()
				continue
			}
			if !need {
				mu.Lock()
				out.Skipped++
				holds[f.Key] = true
				mu.Unlock()
				continue
			}
			if opts.Limit > 0 && atomic.LoadInt64(&uploaded) >= int64(opts.Limit) {
				mu.Lock()
				out.BytesPending += f.Size
				mu.Unlock()
				continue
			}
			if opts.DryRun {
				atomic.AddInt64(&uploaded, 1)
				mu.Lock()
				out.Uploaded++
				out.BytesUploaded += f.Size
				mu.Unlock()
				continue
			}
			if err := uc.put(ctx, target, f); err != nil {
				mu.Lock()
				out.Failed++
				if len(out.Errors) < 10 {
					out.Errors = append(out.Errors, fmt.Sprintf("%s: %v", f.Key, err))
				}
				mu.Unlock()
				continue
			}
			atomic.AddInt64(&uploaded, 1)
			mu.Lock()
			out.Uploaded++
			out.BytesUploaded += f.Size
			holds[f.Key] = true
			mu.Unlock()
		}
	}

	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go worker()
	}
	for _, f := range files {
		select {
		case jobs <- f:
		case <-ctx.Done():
		}
	}
	close(jobs)
	wg.Wait()
	return out, holds
}

func (uc UseCase) put(ctx context.Context, target s3port.Uploader, f assetsport.File) error {
	fh, err := os.Open(f.Path)
	if err != nil {
		return err
	}
	defer fh.Close()
	return target.Put(ctx, f.Key, contentType(f.Key), fh, f.Size)
}

// walk collects the assets to consider, sorted so a run is reproducible and an
// interrupted one resumes in the same order.
func (uc UseCase) walk(opts Options) ([]assetsport.File, error) {
	root := filepath.Join(uc.OutDir, "public")
	if p := strings.Trim(opts.Prefix, "/"); p != "" {
		root = filepath.Join(uc.OutDir, filepath.FromSlash(p))
	}
	if _, err := os.Stat(root); err != nil {
		return nil, fmt.Errorf("assetsync: %s: %w", root, err)
	}
	want := map[string]bool{}
	for _, id := range opts.TrackIds {
		want[id] = true
	}

	var files []assetsport.File
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		rel, err := filepath.Rel(uc.OutDir, path)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if len(want) > 0 && !matchesTrack(key, want) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		files = append(files, assetsport.File{Key: key, Path: path, Size: info.Size()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Key < files[j].Key })
	return files, nil
}

// matchesTrack keeps keys of the form public/tracks/<id>/...
func matchesTrack(key string, want map[string]bool) bool {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == "tracks" && i+1 < len(parts) {
			return want[parts[i+1]]
		}
	}
	return false
}

func contentType(key string) string {
	if ct := mime.TypeByExtension(filepath.Ext(key)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}
