// Package index is the write path: one URL in, rows out.
//
// Everything here is arranged around not doing work twice. A page that has not
// changed costs one conditional GET. A file whose normalizer input is
// identical to last time costs no model call. At a quarter of a million files
// that difference is the whole budget.
package index

import (
	"context"
	"log/slog"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/clock"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/extract"
	"github.com/jiva-studio/shruti/discovery/internal/metrics"
)

// Service indexes one URL at a time. The crawl loop is just this in a loop.
type Service struct {
	Fetcher    Fetcher
	Normalizer normalize.Normalizer
	Embedder   Embedder
	Store      Store
	Scripts    *script.Runner
	// Metrics is what this process has done, for the status endpoint. Nil is a
	// service that keeps no count, which is what the single-URL CLI is.
	Metrics *metrics.Counters
	Now     func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return clock.UTC()
}

// Report says what one URL cost and what it produced.
type Report struct {
	URL string `json:"url"`
	// FinalURL is where the request actually landed. A host that redirects its
	// apex to www serves every link under the name it redirected to, and a
	// crawl that only knows the name it asked for rejects all of them.
	FinalURL        string `json:"final_url,omitempty"`
	Status          int    `json:"status,omitempty"`
	NotModified     bool   `json:"not_modified,omitempty"`
	Unchanged       bool   `json:"unchanged,omitempty"`
	PageID          int64  `json:"page_id,omitempty"`
	ItemsFound      int    `json:"items_found"`
	ItemsNew        int    `json:"items_new"`
	ItemsNormalized int    `json:"items_normalized"`
	ChunksIndexed   int    `json:"chunks_indexed"`
	// ItemsFromScript is how many files the source's own script accounted for
	// in full, and which therefore cost no model call.
	ItemsFromScript int `json:"items_from_script,omitempty"`
	// ItemsDeferred is how many files this visit stored without reading, having
	// read as many as one visit may. Non-zero leaves the page unread so it is
	// visited again.
	ItemsDeferred int       `json:"items_deferred,omitempty"`
	MediaVanished int       `json:"media_vanished,omitempty"`
	Links         []string  `json:"-"`
	NextCheckAt   time.Time `json:"next_check_at"`
}

// Item fetches one URL and stores everything it yielded.
//
// force bypasses every skip: it refetches ignoring the stored validators, and
// re-normalizes and re-embeds even when nothing changed.
func (s *Service) Item(ctx context.Context, rawURL, sourceID string, force bool) (*Report, error) {
	now := s.now()
	report := &Report{URL: rawURL}

	page, err := s.Store.PageByURL(ctx, rawURL)
	if err != nil {
		return nil, err
	}

	req := domain.FetchRequest{}
	// A source whose media sits behind an account only shows the address of the
	// file to someone signed in, so its credentials ride along — and so does
	// the gap it asked to be left between requests.
	src, err := s.source(ctx, sourceID)
	if err != nil {
		return nil, err
	}
	if src != nil {
		req.Headers = src.AuthHeaders
		req.Tool = src.Fetcher
		req.MinDelay = time.Duration(src.CrawlDelayMS) * time.Millisecond
	}
	// Ask "has this changed?" only when an unchanged answer would settle it.
	//
	// A page read with a superseded prompt or a superseded script has stale
	// answers however still its bytes are, and a conditional request is
	// answered 304 before there is a body to read — so the page is recorded as
	// unchanged and its validators are never refreshed. It never catches up.
	if page != nil && !force && s.readWithCurrentTools(page, src, scriptOf(src, sourceID)) {
		req.ETag, req.LastModified = page.ETag, page.LastModified
	}

	resp, err := s.Fetcher.Get(ctx, rawURL, req)
	if err != nil {
		return nil, s.recordFailure(ctx, page, src, rawURL, sourceID, err, now)
	}
	report.Status = resp.Status
	report.FinalURL = resp.URL

	// Pages are stored under the URL they finally resolved to. A host that
	// redirects — http to https, or a trailing slash — would otherwise look
	// brand new on every visit, so the schedule and the change detection would
	// never engage.
	if page == nil && resp.URL != rawURL {
		if page, err = s.Store.PageByURL(ctx, resp.URL); err != nil {
			return nil, err
		}
	}

	if resp.NotModified && !force {
		s.Metrics.Page(true, 0, 0, 0)
		return report, s.recordUnchanged(ctx, page, src, report, now)
	}

	extraction, err := extract.Parse(resp.Body, resp.ContentType, resp.URL)
	if err != nil {
		return nil, s.recordFailure(ctx, page, src, rawURL, sourceID, err, now)
	}
	// A source read by an external reader carries neither links nor files as
	// such: a channel arrives as a list of ids, and a video page is itself the
	// recording. Both are knowledge about that site.
	// Which script reads this source, which is not the same as which source it
	// is: fourteen YouTube channels are fourteen sources and one youtube.js.
	scriptID := scriptOf(src, sourceID)
	if s.Scripts != nil && s.Scripts.Has(scriptID) {
		page := script.Page{
			URL: resp.URL, Text: string(resp.Body), HTML: string(resp.Body),
			Path: pathSegments(resp.URL),
		}
		// A script that says where a page points replaces what flattening found
		// rather than adding to it. The reader's output is full of addresses
		// that are not pages — thumbnails, caption tracks, stream formats — and
		// a crawl that follows them spends its budget being turned away by
		// robots.txt.
		if links, err := s.Scripts.Links(ctx, scriptID, page); err != nil {
			slog.WarnContext(ctx, "script_links_failed", "source", sourceID, "err", err.Error())
		} else if links.Answered {
			extraction.Links = links.URLs
		}
		if own, err := s.Scripts.Recordings(ctx, scriptID, page); err != nil {
			slog.WarnContext(ctx, "script_recordings_failed", "source", sourceID, "err", err.Error())
		} else {
			for _, u := range own.URLs {
				extraction.Items = append(extraction.Items, domain.Item{MediaURL: u, PageURL: resp.URL})
			}
		}
	}
	report.Links = extraction.Links
	report.ItemsFound = len(extraction.Items)

	// Three cheap comparisons, cheapest first: the body, then the set of files
	// on it. A listing whose markup churns but whose files are the same has not
	// changed for our purposes.
	//
	// The prompt counts as well: an unchanged page read with a superseded
	// prompt still has stale answers, and skipping here would make editing a
	// prompt appear to do nothing.
	itemSet := itemSetHash(extraction)
	unchanged := page != nil &&
		page.BodySHA256 == resp.BodySHA256 &&
		page.ItemSetSHA256 == itemSet &&
		s.readWithCurrentTools(page, src, scriptID)
	if unchanged && !force {
		s.Metrics.Page(true, 0, 0, 0)
		return report, s.recordUnchanged(ctx, page, src, report, now)
	}

	pageID, err := s.savePage(ctx, page, resp, src, sourceID, len(extraction.Items), now, report)
	if err != nil {
		return nil, err
	}
	report.PageID = pageID

	if err := s.record(ctx, extraction, pageID, sourceID, src, scriptID, resp.Body, force, now, report); err != nil {
		return nil, s.recordFailure(ctx, page, src, resp.URL, sourceID, err, now)
	}

	// Only now may the page say it has been read. Until this write lands, its
	// validators are whatever the last complete pass left, so the next visit
	// finds them stale and does the work again.
	// A page with files still unread is not a read page. Leaving its validators
	// alone is what brings the crawl back to it.
	if report.ItemsDeferred > 0 {
		slog.InfoContext(ctx, "page_partly_read", "url", resp.URL, "deferred", report.ItemsDeferred)
	} else if err := s.Store.MarkPageIndexed(ctx, pageID, resp.BodySHA256, itemSet,
		s.promptVersion(src), s.scriptVersion(scriptID)); err != nil {
		return nil, err
	}
	s.recordSpend(ctx, sourceID)
	s.Metrics.Page(report.Unchanged, report.ItemsNew, report.ItemsNormalized, report.ChunksIndexed)
	return report, nil
}

// source loads what a source asked for: its credentials and its pace.
func (s *Service) source(ctx context.Context, sourceID string) (*domain.Archive, error) {
	if sourceID == "" {
		return nil, nil
	}
	return s.Store.Source(ctx, sourceID)
}

// scriptOf is which script reads a source. Empty means the source's own id, so
// a source named after its script, like idt and audioveda, needs no setting.
func scriptOf(src *domain.Archive, sourceID string) string {
	if src != nil && src.Script != "" {
		return src.Script
	}
	return sourceID
}

// readWithCurrentTools reports whether this page was last read with the prompt
// and the script we would read it with now.
func (s *Service) readWithCurrentTools(page *domain.Page, src *domain.Archive, scriptID string) bool {
	return page.NormPromptVersion == s.promptVersion(src) &&
		page.ScriptVersion == s.scriptVersion(scriptID)
}

// scriptVersion is which version of this source's own script read the page.
// It sits beside the prompt version in the skip test for the same reason:
// correcting how a source is read must re-read that source, or editing a
// script would change nothing already stored.
func (s *Service) scriptVersion(sourceID string) string {
	return s.Scripts.Version(sourceID)
}

// stated reports whether this archive publishes its own facts, so no model is
// asked about it.
func stated(src *domain.Archive) bool {
	return src != nil && src.Kind == domain.KindStated
}

// promptVersion is the prompt this page would be read with now, empty where no
// prompt is involved. It is a fetch validator, and a prompt cannot change what
// a server sends — so a stated source must not carry one.
func (s *Service) promptVersion(src *domain.Archive) string {
	if s.Normalizer == nil || stated(src) {
		return ""
	}
	return s.Normalizer.PromptVersion()
}

// hasScript reports whether this source is read by one, which is what makes a
// missing answer meaningful rather than expected.
func (s *Service) hasScript(scriptID string) bool {
	return s.Scripts != nil && s.Scripts.Has(scriptID)
}
