package publish

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	s3port "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

// The catalog's `asset_hashes` table is the chat indexer's transcript
// listing — Bunny Edge Storage has no anonymous listing, so the indexer
// reads the published catalog instead. Every row is therefore a promise
// that the file is on the CDN, and a row whose object was never uploaded
// makes the indexer fetch a 404 on every run, forever.
//
// The upload side has no way of knowing about it: assetsync marks a track
// published once and skips it afterwards, so anything written for that
// track later (a second-language transcript) never leaves the lake. That
// hole is closed at the source by the commit → published cascade, but the
// catalog can still carry rows from before the fix or from a publish that
// ran ahead of an assetsync. So publish verifies its own promise: HEAD the
// advertised transcripts on the primary target and ship a copy of the DB
// with the unbacked rows removed.
//
// The rows are dropped from the UPLOADED COPY only, never from local
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

// listTranscriptAssets returns every transcript path the catalog advertises.
func listTranscriptAssets(ctx context.Context, dbPath string) ([]string, error) {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?mode=ro&_busy_timeout=15000", dbPath))
	if err != nil {
		return nil, fmt.Errorf("asset check: open %s: %w", dbPath, err)
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx,
		`SELECT path FROM asset_hashes WHERE kind = 'transcript' AND path <> ''`)
	if err != nil {
		// A catalog predating the asset_hashes schema advertises nothing,
		// so there is nothing to verify.
		if strings.Contains(err.Error(), "no such table") {
			return nil, nil
		}
		return nil, fmt.Errorf("asset check: read asset_hashes: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

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

// verifyTranscriptAssets probes the catalog's advertised transcripts against
// the target. It returns the summary; the caller decides what to ship.
func verifyTranscriptAssets(ctx context.Context, dbPath string, target s3port.Uploader, opts assetCheckOpts) (AssetCheck, []string, error) {
	paths, err := listTranscriptAssets(ctx, dbPath)
	if err != nil {
		return AssetCheck{}, nil, err
	}
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

// writePrunedCopy copies srcDB next to itself and withdraws the named
// transcript paths from the copy — both advertisements, the `asset_hashes`
// row the indexer lists and the `track_variants.transcript_path` the clients
// resolve. Returns the copy's path; the caller removes it. The name is
// dot-prefixed so an assetsync walk skips it.
func writePrunedCopy(ctx context.Context, srcDB string, paths []string) (string, error) {
	tmp, err := os.CreateTemp(filepath.Dir(srcDB), ".publish-*.db")
	if err != nil {
		return "", fmt.Errorf("prune: temp db: %w", err)
	}
	dst := tmp.Name()
	src, err := os.Open(srcDB)
	if err != nil {
		tmp.Close()
		removeDBFiles(dst)
		return "", err
	}
	_, err = io.Copy(tmp, src)
	src.Close()
	tmp.Close()
	if err != nil {
		removeDBFiles(dst)
		return "", fmt.Errorf("prune: copy db: %w", err)
	}

	if err := withdrawTranscripts(ctx, dst, paths); err != nil {
		removeDBFiles(dst)
		return "", err
	}
	// The deletes went to the copy's own write-ahead log; fold them in
	// before the file is read as bytes.
	if err := checkpointWAL(ctx, dst); err != nil {
		removeDBFiles(dst)
		return "", err
	}
	return dst, nil
}

func withdrawTranscripts(ctx context.Context, dbPath string, paths []string) error {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?_busy_timeout=15000", dbPath))
	if err != nil {
		return fmt.Errorf("prune: open copy: %w", err)
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	dropHash, err := tx.PrepareContext(ctx, `DELETE FROM asset_hashes WHERE path = ?`)
	if err != nil {
		return err
	}
	defer dropHash.Close()
	// The variant row stays — only its pointer at a file nobody can fetch
	// goes. A variant without a transcript is a normal state everywhere
	// downstream (mobile maps it to `transcript: null`, chat's resolver
	// falls through to another language), whereas a variant that vanished
	// would take the track's title with it.
	clearPointer, err := tx.PrepareContext(ctx,
		`UPDATE track_variants SET transcript_path = NULL, transcript_kind = NULL
		 WHERE transcript_path = ?`)
	if err != nil {
		return err
	}
	defer clearPointer.Close()

	for _, p := range paths {
		if _, err := dropHash.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("prune %s: %w", p, err)
		}
		if _, err := clearPointer.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("prune %s (variant pointer): %w", p, err)
		}
	}
	return tx.Commit()
}

// removeDBFiles drops a SQLite file together with its WAL sidecars.
func removeDBFiles(path string) {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
}
