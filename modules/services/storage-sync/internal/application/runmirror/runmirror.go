// Package runmirror is storage-sync's mirroring core. It keeps the Russia
// mirror faithful to Bunny along two paths:
//
//   - FullPass — the periodic reconciler: walk the source, diff it against the
//     mirror's listing, ship what changed, optionally prune what is gone.
//   - SyncTrack — the event-driven fast path: ship the handful of objects a
//     just-published track named, so a user reading through the mirror does not
//     wait up to a full interval for audio that the app already calls "ready".
//
// A regular full pass reads no single object from the mirror. It compares each
// source object against the listing (present, same size) and against the
// checksum this process last saw the mirror hold for the key — recorded by
// every checksum read and every copy — so an in-place rewrite of the same size
// is shipped on the next pass. Only the mutable keys named in the Scope, and
// keys whose last attempt failed, are read by checksum on a regular pass. A
// deep pass reads the stamp of every listed object; it runs first (which is
// also what fills the checksum record after a restart) and then once per
// DeepEvery. The fast path uses the same checksum rule (mirror.NeedsTransfer)
// and the same transfer. The core talks only to ports — no HTTP, no S3, no
// Redis — so it is exercised end to end with fakes.
package runmirror

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/jiva-studio/shruti-storage-sync/internal/domain/mirror"
	"github.com/jiva-studio/shruti-storage-sync/internal/ports"
)

// Deps bundles the ports and the pass policy.
type Deps struct {
	Source ports.SourceStore
	Mirror ports.MirrorStore

	// Prefix scopes both the walk and the prune. Empty = the whole bucket.
	Prefix string
	// Concurrency bounds the parallel checksum reads and transfers of a full pass.
	Concurrency int
	// DryRun performs every read and decision but skips the writes.
	DryRun bool
	// Prune deletes mirror objects that no longer exist on the source. Only ever
	// applied by a FULL pass — a targeted sync has no authority to delete,
	// because it has not observed the whole source.
	Prune bool
	// Scope names the excluded prefixes and the mutable keys. Both paths skip
	// excluded keys.
	Scope mirror.Scope
	// DeepEvery is the cadence of the deep pass, which compares every listed
	// object by checksum. Zero makes every pass deep.
	DeepEvery time.Duration
	// Now is the clock the deep cadence is measured on. Without it every pass
	// is deep.
	Now func() time.Time
}

// Service is the mirroring core.
type Service struct {
	d Deps

	mu       sync.Mutex
	lastDeep time.Time           // start of the last deep pass
	held     map[string]string   // key → checksum the mirror was last seen or written with
	retry    map[string]struct{} // keys whose last full-pass read or copy failed
}

// New builds the core, defaulting the concurrency.
func New(d Deps) *Service {
	if d.Concurrency < 1 {
		d.Concurrency = 16
	}
	return &Service{d: d, held: map[string]string{}, retry: map[string]struct{}{}}
}

// PassResult summarises one full reconciling pass.
//
// Listed and Heads are the requests the pass cost on the mirror side: objects
// read from the bucket listing, and single-object checksum reads. Bytes is the
// source size of what was copied. Retrying is how many keys failed this pass
// and will be read by checksum again on the next one.
type PassResult struct {
	Source   int
	Listed   int
	Heads    int
	Copied   int
	Bytes    int64
	Failed   int
	Deleted  int
	Retrying int
	Deep     bool
}

// FullPass reconciles the whole prefix. A per-object failure — a checksum read
// or a transfer — is counted, logged and retried on the next pass while
// the pass carries on, since one bad object must not strand the rest; a non-zero
// Failed is returned as an error so the caller can log the run as
// unhealthy. A deep pass counts as done once the walk and the listing
// succeeded, failures or not, so a single stuck object never makes every pass
// deep. The walk or the listing failing IS fatal to the pass.
func (s *Service) FullPass(ctx context.Context) (PassResult, error) {
	started, deep := s.startPass()
	res := PassResult{Deep: deep}

	src, err := s.d.Source.Walk(ctx, s.d.Prefix)
	if err != nil {
		return res, fmt.Errorf("walk: %w", err)
	}
	for key := range src {
		if s.d.Scope.IsExcluded(key) {
			delete(src, key)
		}
	}
	res.Source = len(src)
	s.keepHeld(src)

	listed, err := s.d.Mirror.List(ctx, s.d.Prefix)
	if err != nil {
		return res, fmt.Errorf("list mirror: %w", err)
	}
	res.Listed = len(listed)
	sizes := make(map[string]int64, len(listed))
	for _, l := range listed {
		if !s.d.Scope.IsExcluded(l.Key) {
			sizes[l.Key] = l.Size
		}
	}
	if deep {
		s.finishDeep(started)
	}

	todo, inspect := s.partition(src, sizes, deep)
	stale, inspectFailed := s.inspectAll(ctx, inspect)
	res.Heads = len(inspect)
	var transferFailed []string
	res.Copied, res.Bytes, transferFailed = s.transferAll(ctx, append(todo, stale...))
	failed := slices.Concat(inspectFailed, transferFailed)
	res.Failed = len(failed)
	res.Retrying = s.replaceRetry(failed)

	if s.d.Prune {
		deleted, err := s.pruneStale(ctx, src, sizes)
		if err != nil {
			slog.WarnContext(ctx, "prune_failed", "err", err.Error())
		}
		res.Deleted = deleted
	}
	if res.Failed > 0 {
		return res, fmt.Errorf("%d objects failed", res.Failed)
	}
	return res, nil
}

// startPass reads the clock once and decides whether this pass is deep.
func (s *Service) startPass() (time.Time, bool) {
	if s.d.DeepEvery <= 0 || s.d.Now == nil {
		return time.Time{}, true
	}
	now := s.d.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	return now, s.lastDeep.IsZero() || now.Sub(s.lastDeep) >= s.d.DeepEvery
}

func (s *Service) finishDeep(started time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastDeep = started
}

// partition splits the source into objects that must ship without reading the
// mirror and objects whose checksum stamp has to be read first.
func (s *Service) partition(src map[string]mirror.Object, sizes map[string]int64, deep bool) (todo, inspect []mirror.Object) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, obj := range src {
		size, listed := sizes[key]
		_, retrying := s.retry[key]
		held := mirror.Held{Listed: listed, Size: size, SHA256: s.held[key]}
		switch mirror.CompareListed(obj, held, deep || retrying || s.d.Scope.IsMutable(key)) {
		case mirror.Transfer:
			todo = append(todo, obj)
		case mirror.Inspect:
			inspect = append(inspect, obj)
		case mirror.Skip:
		}
	}
	return todo, inspect
}

// replaceRetry makes the keys that failed this pass the ones retried next.
func (s *Service) replaceRetry(failed []string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.retry = make(map[string]struct{}, len(failed))
	for _, k := range failed {
		s.retry[k] = struct{}{}
	}
	return len(s.retry)
}

// recordHeld remembers the checksum the mirror holds for key. An empty stamp
// (an object without a checksum stamp) records "unknown", so such keys stay
// compared by size.
func (s *Service) recordHeld(key, sha string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.held[key] = sha
}

// keepHeld keeps the checksum record only for keys in the source listing.
func (s *Service) keepHeld(src map[string]mirror.Object) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.held {
		if _, ok := src[k]; !ok {
			delete(s.held, k)
		}
	}
}

// SyncTrack ships exactly the blobs a `track.ready` announced. Idempotent: an
// object the mirror already holds (same checksum) is skipped, so a redelivered
// event is a cheap no-op. Returns how many objects were actually copied.
func (s *Service) SyncTrack(ctx context.Context, t mirror.TrackReady) (int, error) {
	return s.SyncKeys(ctx, t.Keys())
}

// SyncKeys ships named objects immediately. Sequential on purpose — the caller
// passes a handful of keys, and determinism beats parallelism at this size.
// Excluded keys are skipped, exactly as the full pass skips them.
//
// A key missing from the SOURCE is not an error: ingest HEAD-verifies both blobs
// before announcing a track, so this means the listing is momentarily behind.
// It is logged and left to the next full pass rather than failing the message
// forever.
func (s *Service) SyncKeys(ctx context.Context, keys []string) (int, error) {
	copied := 0
	for _, key := range keys {
		if s.d.Scope.IsExcluded(key) {
			slog.InfoContext(ctx, "excluded_key_skipped", "key", key)
			continue
		}
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

// needsTransfer reads the mirror's current state, records its stamp and
// applies the domain rule.
func (s *Service) needsTransfer(ctx context.Context, obj mirror.Object) (bool, error) {
	state, err := s.d.Mirror.State(ctx, obj.Key)
	if err != nil {
		return false, err
	}
	s.recordHeld(obj.Key, state.SHA256)
	return mirror.NeedsTransfer(obj, state), nil
}

// transferOne streams one object source → mirror, carrying the checksum stamp
// the next pass will compare against, and records that stamp as held. DryRun
// stops before the write.
func (s *Service) transferOne(ctx context.Context, obj mirror.Object) error {
	if s.d.DryRun {
		return nil
	}
	body, contentType, err := s.d.Source.Open(ctx, obj.Key)
	if err != nil {
		return err
	}
	defer body.Close()
	if err := s.d.Mirror.Put(ctx, obj, body, contentType); err != nil {
		return err
	}
	s.recordHeld(obj.Key, obj.SHA256)
	return nil
}

// inspectAll reads the checksum stamp of each object in parallel and returns
// those the domain says must ship, plus the keys whose read failed.
func (s *Service) inspectAll(ctx context.Context, objs []mirror.Object) (stale []mirror.Object, failed []string) {
	var mu sync.Mutex
	sem := make(chan struct{}, s.d.Concurrency)
	var wg sync.WaitGroup
	for _, obj := range objs {
		wg.Add(1)
		go func(obj mirror.Object) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			need, err := s.needsTransfer(ctx, obj)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				slog.WarnContext(ctx, "mirror_state_failed", "key", obj.Key, "err", err.Error())
				failed = append(failed, obj.Key)
				return
			}
			if need {
				stale = append(stale, obj)
			}
		}(obj)
	}
	wg.Wait()
	return stale, failed
}

// transferAll ships the selected objects in parallel, counting outcomes and
// returning the keys that failed.
func (s *Service) transferAll(ctx context.Context, todo []mirror.Object) (copied int, bytes int64, failed []string) {
	var mu sync.Mutex
	sem := make(chan struct{}, s.d.Concurrency)
	var wg sync.WaitGroup
	for _, obj := range todo {
		wg.Add(1)
		go func(obj mirror.Object) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			err := s.transferOne(ctx, obj)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				slog.WarnContext(ctx, "transfer_failed", "key", obj.Key, "err", err.Error())
				failed = append(failed, obj.Key)
				return
			}
			copied++
			bytes += obj.Size
		}(obj)
	}
	wg.Wait()
	return copied, bytes, failed
}

// pruneStale deletes listed mirror objects that are absent from the source.
// Both maps have had the excluded prefixes removed, so an excluded key is never
// a candidate. DryRun reports the count without deleting.
func (s *Service) pruneStale(ctx context.Context, src map[string]mirror.Object, listed map[string]int64) (int, error) {
	stale := make([]string, 0)
	for k := range listed {
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
