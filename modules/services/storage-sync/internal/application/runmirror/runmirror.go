// Package runmirror is storage-sync's mirroring core. It keeps the Russia
// mirror faithful to Bunny along two paths:
//
//   - FullPass — the periodic reconciler: walk the source, diff against the
//     mirror by checksum, ship what changed, optionally prune what is gone.
//   - SyncTrack — the event-driven fast path: ship the handful of objects a
//     just-published track named, so a user reading through the mirror does not
//     wait up to a full interval for audio that the app already calls "ready".
//
// Both paths share ONE decision (mirror.NeedsTransfer) and ONE transfer, so the
// fast path can never drift from the reconciler. The core talks only to ports —
// no HTTP, no S3, no Redis — so it is exercised end to end with fakes.
package runmirror

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/jiva-studio/lectorium-storage-sync/internal/domain/mirror"
	"github.com/jiva-studio/lectorium-storage-sync/internal/ports"
)

// Deps bundles the ports and the pass policy.
type Deps struct {
	Source ports.SourceStore
	Mirror ports.MirrorStore

	// Prefix scopes both the walk and the prune. Empty = the whole bucket.
	Prefix string
	// Concurrency bounds the parallel head-checks and transfers of a full pass.
	Concurrency int
	// DryRun performs every read and decision but skips the writes.
	DryRun bool
	// Prune deletes mirror objects that no longer exist on the source. Only ever
	// applied by a FULL pass — a targeted sync has no authority to delete,
	// because it has not observed the whole source.
	Prune bool
}

// Service is the mirroring core.
type Service struct{ d Deps }

// New builds the core, defaulting the concurrency.
func New(d Deps) *Service {
	if d.Concurrency < 1 {
		d.Concurrency = 16
	}
	return &Service{d: d}
}

// PassResult summarises one full reconciling pass.
type PassResult struct {
	Source  int // objects seen on the source
	Copied  int
	Failed  int
	Deleted int
}

// FullPass reconciles the whole prefix. A per-object failure is counted and
// logged rather than aborting the pass — one bad object must not strand the
// rest — but a non-zero Failed is returned as an error so the caller can log
// the run as unhealthy. The walk itself failing IS fatal to the pass.
func (s *Service) FullPass(ctx context.Context) (PassResult, error) {
	src, err := s.d.Source.Walk(ctx, s.d.Prefix)
	if err != nil {
		return PassResult{}, fmt.Errorf("walk: %w", err)
	}
	res := PassResult{Source: len(src)}

	todo := s.selectStale(ctx, src)
	res.Copied, res.Failed = s.transferAll(ctx, todo)

	if s.d.Prune {
		deleted, err := s.pruneStale(ctx, src)
		if err != nil {
			slog.WarnContext(ctx, "prune_failed", "err", err.Error())
		}
		res.Deleted = deleted
	}
	if res.Failed > 0 {
		return res, fmt.Errorf("%d transfers failed", res.Failed)
	}
	return res, nil
}

// SyncTrack ships exactly the blobs a `track.ready` announced. Idempotent: an
// object the mirror already holds (same checksum) is skipped, so a redelivered
// event is a cheap no-op. Returns how many objects were actually copied.
func (s *Service) SyncTrack(ctx context.Context, t mirror.TrackReady) (int, error) {
	return s.SyncKeys(ctx, t.Keys())
}

// SyncKeys ships named objects immediately. Sequential on purpose — the caller
// passes a handful of keys, and determinism beats parallelism at this size.
//
// A key missing from the SOURCE is not an error: ingest HEAD-verifies both blobs
// before announcing a track, so this means the listing is momentarily behind.
// It is logged and left to the next full pass rather than failing the message
// forever.
func (s *Service) SyncKeys(ctx context.Context, keys []string) (int, error) {
	copied := 0
	for _, key := range keys {
		obj, found, err := s.d.Source.Stat(ctx, key)
		if err != nil {
			return copied, fmt.Errorf("stat %s: %w", key, err)
		}
		if !found {
			slog.WarnContext(ctx, "source_object_missing", "key", key)
			continue
		}
		need, err := s.needsTransfer(ctx, obj)
		if err != nil {
			return copied, fmt.Errorf("mirror state %s: %w", key, err)
		}
		if !need {
			continue
		}
		if err := s.transferOne(ctx, obj); err != nil {
			return copied, fmt.Errorf("transfer %s: %w", key, err)
		}
		copied++
	}
	return copied, nil
}

// needsTransfer reads the mirror's current state and applies the domain rule.
func (s *Service) needsTransfer(ctx context.Context, obj mirror.Object) (bool, error) {
	state, err := s.d.Mirror.State(ctx, obj.Key)
	if err != nil {
		return false, err
	}
	return mirror.NeedsTransfer(obj, state), nil
}

// transferOne streams one object source → mirror, carrying the checksum stamp
// the next pass will compare against. DryRun stops before the write.
func (s *Service) transferOne(ctx context.Context, obj mirror.Object) error {
	if s.d.DryRun {
		return nil
	}
	body, contentType, err := s.d.Source.Open(ctx, obj.Key)
	if err != nil {
		return err
	}
	defer body.Close()
	return s.d.Mirror.Put(ctx, obj, body, contentType)
}

// selectStale head-checks every source object in parallel and returns those the
// domain says must ship. A head-check error is logged and the object skipped —
// the next pass retries it.
func (s *Service) selectStale(ctx context.Context, src map[string]mirror.Object) []mirror.Object {
	out := make([]mirror.Object, 0)
	var mu sync.Mutex
	sem := make(chan struct{}, s.d.Concurrency)
	var wg sync.WaitGroup
	for _, obj := range src {
		wg.Add(1)
		go func(obj mirror.Object) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			need, err := s.needsTransfer(ctx, obj)
			if err != nil {
				slog.WarnContext(ctx, "mirror_state_failed", "key", obj.Key, "err", err.Error())
				return
			}
			if need {
				mu.Lock()
				out = append(out, obj)
				mu.Unlock()
			}
		}(obj)
	}
	wg.Wait()
	return out
}

// transferAll ships the selected objects in parallel, counting outcomes.
func (s *Service) transferAll(ctx context.Context, todo []mirror.Object) (copied, failed int) {
	var mu sync.Mutex
	sem := make(chan struct{}, s.d.Concurrency)
	var wg sync.WaitGroup
	for _, obj := range todo {
		wg.Add(1)
		go func(obj mirror.Object) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := s.transferOne(ctx, obj); err != nil {
				slog.WarnContext(ctx, "transfer_failed", "key", obj.Key, "err", err.Error())
				mu.Lock()
				failed++
				mu.Unlock()
				return
			}
			mu.Lock()
			copied++
			mu.Unlock()
		}(obj)
	}
	wg.Wait()
	return copied, failed
}

// pruneStale deletes mirror objects that no longer exist on the source. DryRun
// reports the count without deleting.
func (s *Service) pruneStale(ctx context.Context, src map[string]mirror.Object) (int, error) {
	keys, err := s.d.Mirror.ListKeys(ctx, s.d.Prefix)
	if err != nil {
		return 0, err
	}
	stale := make([]string, 0)
	for _, k := range keys {
		if _, ok := src[k]; !ok {
			stale = append(stale, k)
		}
	}
	if len(stale) == 0 {
		return 0, nil
	}
	if s.d.DryRun {
		return len(stale), nil
	}
	return s.d.Mirror.DeleteKeys(ctx, stale)
}
