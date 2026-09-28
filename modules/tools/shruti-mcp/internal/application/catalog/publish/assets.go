package publish

import (
	"context"
	"fmt"
	"sort"
	"sync"

	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// The catalog's `asset_hashes` table is the chat indexer's transcript
// listing — Bunny Edge Storage has no anonymous listing, so the indexer
// reads the published catalog instead. Every row is therefore a promise
// that the file is on the CDN, and a row whose object was never uploaded
// makes the indexer fetch a 404 on every run, forever.
//
// The upload side cannot vouch for it: the commit → published cascade
// reopens a track when new files are written for it, but the catalog can
// still carry rows whose objects never reached the target, for instance
// from a publish that ran ahead of an assetsync. So publish verifies its
// own promise: HEAD the advertised transcripts on the primary target and
// ship a copy of the DB with the unbacked rows removed.
//
// The rows are dropped from the uploaded copy only, never from local
// current.db: a row pruned here comes back by itself on the next publish
// once the asset lands, and no local state is lost if the target lied.
//
// asset_hashes is not the only advertisement. `track_variants.transcript_path`
// is the one the *clients* read (mobile builds its transcript descriptor from
// it; chat's own transcript lookup resolves it), so removing the hash row
// alone would silence the indexer and leave every reader still pointed at the
// 404. Both are cleared for the same path, in the same copy.

const (
	defaultAssetCheckConcurrency = 32

	// Pruning is for stragglers, not for outages. A target that answers
	// "not found" for a large share of the corpus is broken or pointed at
	// the wrong bucket, and shipping a catalog stripped of thousands of
	// transcripts would take the whole chat corpus down — refuse instead.
	maxPruneShare = 0.05
	// …but a small catalog (or a small corpus in early bootstrap) must not
	// trip the share test on a couple of files.
	minPruneFloor = 50
)

// AssetCheck is the publish-time verification summary, reported in Result.
type AssetCheck struct {
	Checked int `json:"transcripts_checked"`
	// Pruned is the number of advertised transcripts the target does not
	// hold; their asset_hashes rows are absent from the published DB.
	Pruned int `json:"transcripts_pruned,omitempty"`
	// PrunedSample lists the first few pruned paths so the operator can act
	// on them (usually: run assetsync, or drop the variant).
	PrunedSample []string `json:"transcripts_pruned_sample,omitempty"`
	// Unverifiable counts paths whose HEAD errored out. Those are kept —
	// an unanswered probe is not evidence of a missing file.
	Unverifiable int `json:"transcripts_unverifiable,omitempty"`
	// Forced records that the operator waived the prune budget.
	Forced bool `json:"prune_budget_waived,omitempty"`
}

// assetCheckOpts are the knobs the publish caller passes through.
type assetCheckOpts struct {
	// Concurrency is the number of HEAD probes in flight; 0 = default.
	Concurrency int
	// Force waives the prune budget: every unbacked row is dropped from the
	// uploaded copy no matter how many there are, instead of refusing the
	// publish. The narrow escape from a phantom count over budget — unlike
	// skip_asset_check it still keeps the phantoms out of the catalog.
	Force bool
}

const prunedSampleSize = 10

// missingAssets probes every path on the target and returns the ones it does
// not hold, plus the count of probes that failed outright.
func missingAssets(ctx context.Context, target s3port.Uploader, paths []string, concurrency int) ([]string, int) {
	if concurrency <= 0 {
		concurrency = defaultAssetCheckConcurrency
	}
	var (
		mu           sync.Mutex
		missing      []string
		unverifiable int
		wg           sync.WaitGroup
	)
	jobs := make(chan string)
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				if ctx.Err() != nil {
					return
				}
				_, _, exists, err := target.Head(ctx, p)
				mu.Lock()
				switch {
				case err != nil:
					unverifiable++
				case !exists:
					missing = append(missing, p)
				}
				mu.Unlock()
			}
		}()
	}
	// The workers give up as soon as ctx is done, so an unguarded send here
	// blocks forever once the last one has left — and publish holds OpMutex
	// for the whole run, so that hang takes the whole tool down, not just
	// this call. Stop feeding when ctx is done and let the workers drain.
	for _, p := range paths {
		select {
		case jobs <- p:
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			sort.Strings(missing)
			return missing, unverifiable
		}
	}
	close(jobs)
	wg.Wait()
	sort.Strings(missing)
	return missing, unverifiable
}

// verifyTranscriptAssets probes the transcripts a catalog advertises against
// the target. It returns the summary; the caller decides what to ship.
func verifyTranscriptAssets(ctx context.Context, paths []string, target s3port.Uploader, opts assetCheckOpts) (AssetCheck, []string, error) {
	check := AssetCheck{Checked: len(paths)}
	if len(paths) == 0 {
		return check, nil, nil
	}
	missing, unverifiable := missingAssets(ctx, target, paths, opts.Concurrency)
	// A cancelled sweep probed only a prefix of the corpus, so "not found"
	// is a verdict on nothing — the unprobed rest would look present.
	if err := ctx.Err(); err != nil {
		return AssetCheck{}, nil, fmt.Errorf("asset check: %w", err)
	}
	check.Unverifiable = unverifiable
	if len(missing) == 0 {
		return check, nil, nil
	}
	over := pruneBudget(len(paths))
	if overBudget := len(missing) > over; overBudget {
		if !opts.Force {
			return check, nil, fmt.Errorf(
				"asset check: %s is missing %d of %d advertised transcripts (budget %d) — "+
					"that reads as a target/credential problem, not stale rows; "+
					"publish refused (first missing: %s). If the target is known good and "+
					"the corpus really has that many phantoms, re-run with force_prune to "+
					"drop them from the published copy; skip_asset_check would ship them all",
				target.Name(), len(missing), len(paths), over, missing[0])
		}
		check.Forced = true
	}
	check.Pruned = len(missing)
	check.PrunedSample = missing[:min(len(missing), prunedSampleSize)]
	return check, missing, nil
}

// pruneBudget is how many missing assets publish is willing to write off as
// stale rows rather than read as a broken target.
func pruneBudget(total int) int {
	budget := int(float64(total) * maxPruneShare)
	if budget < minPruneFloor {
		budget = minPruneFloor
	}
	return budget
}
