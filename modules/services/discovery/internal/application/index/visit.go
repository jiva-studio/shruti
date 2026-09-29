package index

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// fetchable drops the addresses robots.txt puts out of bounds.
//
// This is why they are dropped before they are stored rather than before they
// are fetched: page_links is where the crawl picks up work it has not done, and
// an address we may never fetch stays unvisited forever. One page of a video
// site links to three hundred caption endpoints under a forbidden path; stored,
// they crowd every later run out of its own budget while the run reports that
// the site refused it.
func (s *Service) fetchable(ctx context.Context, links []string) []string {
	if s.Fetcher == nil || len(links) == 0 {
		return links
	}
	out := make([]string, 0, len(links))
	for _, u := range links {
		if s.Fetcher.Allowed(ctx, u) {
			out = append(out, u)
		}
	}
	return out
}

// storePageLinks records what a page pointed at, which is how the crawl walks
// through a page it is not due to fetch.
//
// No model is asked whether a page of links is a cycle of recordings. Deciding
// a talk belongs to a set is a judgement, and an archive that states its own
// grouping makes it unnecessary. Where a source says nothing, we say nothing.
func (s *Service) storePageLinks(ctx context.Context, pageID int64, links []string) error {
	links = s.fetchable(ctx, links)
	if len(links) == 0 {
		return nil
	}
	return s.Store.ReplacePageLinks(ctx, pageID, links)
}

// markVanished notes the files an earlier visit found on this page and this one did not.
//
// Nothing is deleted and nothing is re-read: the recording is still the same
// recording, and whether the archive removed the file or our session lapsed is
// not something this visit can tell. The date it went missing is what makes
// that answerable later.
func (s *Service) markVanished(ctx context.Context, e *domain.Extraction, pageID int64,
	now time.Time, report *Report) error {

	prior, err := s.Store.ItemsByPage(ctx, pageID)
	if err != nil {
		return err
	}
	// A page that offered recordings and now offers none is far more often a
	// lapsed session or an error served with a 200 than an emptied page, and
	// believing it costs every recording on that page at once. Nothing is marked
	// on it; their media_seen_at stops moving instead, which is what finding
	// genuinely withdrawn recordings goes by.
	if len(e.Items) == 0 && len(prior) > 0 {
		slog.WarnContext(ctx, "page_offered_nothing", "page_id", pageID, "known", len(prior))
		return nil
	}
	found := make(map[string]bool, len(e.Items))
	for _, it := range e.Items {
		found[it.MediaURL] = true
	}
	for _, it := range prior {
		if it.MediaURL == "" || found[it.MediaURL] {
			continue
		}
		if err := s.Store.MarkMediaVanished(ctx, it.ID, now); err != nil {
			return err
		}
		report.MediaVanished++
	}
	return nil
}

// savePage records the visit, but not the proof that it succeeded.
//
// The three validators — the hash of the body, the hash of the file set, and
// the prompt version — are deliberately left empty here and written by
// MarkPageIndexed once the recordings are stored. SavePage coalesces an empty
// validator to whatever is already in the row, so an attempt that fails leaves
// the last complete pass's proof intact rather than replacing it with a claim
// this attempt did not earn.
func (s *Service) savePage(ctx context.Context, page *domain.Page, resp *domain.FetchResponse,
	src *domain.Archive, sourceID string, mediaFound int, now time.Time, report *Report) (int64, error) {

	floor, ceiling := recheckBounds(src)
	next := NextCheck(0, floor, ceiling, now)
	report.NextCheckAt = next
	p := &domain.Page{
		URL:                  resp.URL,
		ETag:                 resp.ETag,
		LastModified:         resp.LastModified,
		HTTPStatus:           resp.Status,
		LastFetchedAt:        &now,
		ConsecutiveUnchanged: 0,
		NextCheckAt:          &next,
		MediaFound:           mediaFound,
	}
	if page != nil {
		p.ID = page.ID
	}
	if sourceID != "" {
		p.SourceID = &sourceID
	}
	return s.Store.SavePage(ctx, p)
}

// recordUnchanged notes that a visit found nothing new and pushes the next one
// further out.
func (s *Service) recordUnchanged(ctx context.Context, page *domain.Page, src *domain.Archive,
	report *Report, now time.Time) error {

	report.NotModified = true
	report.Unchanged = true
	if page == nil {
		return nil
	}
	page.ConsecutiveUnchanged++
	// A visit that answered is not a failure, whatever the last one was.
	page.ConsecutiveFailures = 0
	page.LastFetchedAt = &now
	floor, ceiling := recheckBounds(src)
	next := NextCheck(page.ConsecutiveUnchanged, floor, ceiling, now)
	page.NextCheckAt = &next
	page.Error = ""
	report.NextCheckAt = next
	// Nothing else to do: an unchanged page points where it pointed last time,
	// and its links are already stored.
	_, err := s.Store.SavePage(ctx, page)
	return err
}

// recheckBounds is how often this source wants its pages read again. A source
// we know nothing about gets the service defaults rather than no bound at all.
func recheckBounds(src *domain.Archive) (time.Duration, time.Duration) {
	if src == nil {
		return DefaultRecheckMin, DefaultRecheckMax
	}
	return time.Duration(src.RecheckMinS) * time.Second,
		time.Duration(src.RecheckMaxS) * time.Second
}

// recordFailure stores why a page could not be read, so a persistent problem
// is visible instead of showing up as a page that simply never updates.
func (s *Service) recordFailure(ctx context.Context, page *domain.Page, src *domain.Archive,
	url, sourceID string, cause error, now time.Time) error {

	s.Metrics.Failure(domain.FetchErrorKind(cause))
	fails := 1
	if page != nil {
		fails = page.ConsecutiveFailures + 1
	}
	// The retry backs off the same way a page that never changes does, and
	// stops at the source's own ceiling. An address that has been gone for
	// years is not worth asking for twenty four times a day.
	_, ceiling := recheckBounds(src)
	next := RetryAt(fails, ceiling, now)
	p := &domain.Page{
		URL:                 url,
		Error:               cause.Error(),
		LastFetchedAt:       &now,
		NextCheckAt:         &next,
		ConsecutiveFailures: fails,
	}
	if page != nil {
		p.ID = page.ID
		p.ETag, p.LastModified = page.ETag, page.LastModified
		p.ConsecutiveUnchanged = page.ConsecutiveUnchanged
	}
	if sourceID != "" {
		p.SourceID = &sourceID
	}
	if _, err := s.Store.SavePage(ctx, p); err != nil {
		return fmt.Errorf("%w (and recording it failed: %v)", cause, err)
	}
	return cause
}

// itemSetHash fingerprints which files a page offers, independent of the
// markup around them.
func itemSetHash(e *domain.Extraction) string {
	urls := make([]string, 0, len(e.Items))
	for _, it := range e.Items {
		urls = append(urls, it.MediaURL)
	}
	sort.Strings(urls)
	sum := sha256.Sum256([]byte(strings.Join(urls, "\n")))
	return hex.EncodeToString(sum[:])
}
