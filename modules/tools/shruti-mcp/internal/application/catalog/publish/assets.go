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

	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
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
	for _, p := range paths {
		jobs <- p
	}
	close(jobs)
	wg.Wait()
	sort.Strings(missing)
	return missing, unverifiable
}

// verifyTranscriptAssets probes the catalog's advertised transcripts against
// the target. It returns the summary; the caller decides what to ship.
func verifyTranscriptAssets(ctx context.Context, dbPath string, target s3port.Uploader, concurrency int) (AssetCheck, []string, error) {
	paths, err := listTranscriptAssets(ctx, dbPath)
	if err != nil {
		return AssetCheck{}, nil, err
	}
	check := AssetCheck{Checked: len(paths)}
	if len(paths) == 0 {
		return check, nil, nil
	}
	missing, unverifiable := missingAssets(ctx, target, paths, concurrency)
	check.Unverifiable = unverifiable
	if len(missing) == 0 {
		return check, nil, nil
	}
	if over := pruneBudget(len(paths)); len(missing) > over {
		return check, nil, fmt.Errorf(
			"asset check: %s is missing %d of %d advertised transcripts (budget %d) — "+
				"that reads as a target/credential problem, not stale rows; "+
				"publish refused (first missing: %s)",
			target.Name(), len(missing), len(paths), over, missing[0])
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

// writePrunedCopy copies srcDB next to itself and deletes the named
// asset_hashes rows from the copy. Returns the copy's path; the caller
// removes it. The name is dot-prefixed so an assetsync walk skips it.
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

	if err := deleteAssetRows(ctx, dst, paths); err != nil {
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

func deleteAssetRows(ctx context.Context, dbPath string, paths []string) error {
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
	stmt, err := tx.PrepareContext(ctx, `DELETE FROM asset_hashes WHERE path = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, p := range paths {
		if _, err := stmt.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("prune %s: %w", p, err)
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
