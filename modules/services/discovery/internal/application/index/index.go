// Package index is the write path: one URL in, rows out.
//
// Everything here is arranged around not doing work twice. A page that has not
// changed costs one conditional GET. A file whose normalizer input is
// identical to last time costs no model call. At a quarter of a million files
// that difference is the whole budget.
package index

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/extract"
	"github.com/jiva-studio/shruti/discovery/internal/infra/embed"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	"github.com/jiva-studio/shruti/discovery/internal/metrics"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// Fetcher is the polite HTTP client, narrowed to what indexing needs.
type Fetcher interface {
	Get(ctx context.Context, url string, req fetch.Request) (*fetch.Response, error)
	Allowed(ctx context.Context, url string) bool
}

// Embedder turns text into vectors. Nil leaves items stored but unsearchable
// by meaning, which is a degraded service rather than a broken one.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Model() string
	// Spent is what the calls made so far were billed, and forgets them. The
	// larger half of what this service spends is embedding, and it went
	// uncounted while the provider was reporting it on every answer.
	Spent() []embed.Spend
}

// Service indexes one URL at a time. The crawl loop is just this in a loop.
type Service struct {
	Fetcher    Fetcher
	Normalizer normalize.Normalizer
	Embedder   Embedder
	Repo       *store.Repo
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
	return time.Now().UTC()
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

	page, err := s.Repo.PageByURL(ctx, rawURL)
	if err != nil {
		return nil, err
	}

	req := fetch.Request{}
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
		if page, err = s.Repo.PageByURL(ctx, resp.URL); err != nil {
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
	// prompt still has stale answers, and skipping here would be the reason
	// editing a prompt appeared to do nothing.
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
	} else if err := s.Repo.MarkPageIndexed(ctx, pageID, resp.BodySHA256, itemSet,
		s.promptVersion(src), s.scriptVersion(scriptID)); err != nil {
		return nil, err
	}
	s.recordSpend(ctx, sourceID)
	s.Metrics.Page(report.Unchanged, report.ItemsNew, report.ItemsNormalized, report.ChunksIndexed)
	return report, nil
}

// recordSpend keeps what the model calls for this page cost.
//
// A failure to write it is not a failure to index: the recording is stored and
// the bill arrives regardless, so this complains and carries on.
func (s *Service) recordSpend(ctx context.Context, sourceID string) {
	if s.Normalizer == nil {
		return
	}
	for _, sp := range s.Normalizer.Spent() {
		kind := sp.Kind
		if kind == "" {
			kind = "normalize"
		}
		row := store.Spend{SourceID: sourceID, Kind: kind, Model: sp.Model, Items: sp.Items}
		if sp.Reported {
			in, out, cost := sp.TokensIn, sp.TokensOut, sp.CostUSD
			row.TokensIn, row.TokensOut, row.CostUSD = &in, &out, &cost
		}
		s.Metrics.Spend(sp.CostUSD)
		if err := s.Repo.RecordSpend(ctx, row); err != nil {
			slog.WarnContext(ctx, "spend_not_recorded", "source", sourceID, "err", err.Error())
		}
	}
}

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
	return s.Repo.ReplacePageLinks(ctx, pageID, links)
}

// markVanished notes the files this page used to offer and does not any more.
//
// Nothing is deleted and nothing is re-read: the recording is still the same
// recording, and whether the archive removed the file or our session lapsed is
// not something this visit can tell. The date it went missing is what makes
// that answerable later.
func (s *Service) markVanished(ctx context.Context, e *domain.Extraction, pageID int64,
	now time.Time, report *Report) error {

	prior, err := s.Repo.ItemsByPage(ctx, pageID)
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
		if err := s.Repo.MarkMediaVanished(ctx, it.ID, now); err != nil {
			return err
		}
		report.MediaVanished++
	}
	return nil
}

// source loads what a source asked for: its credentials and its pace.
func (s *Service) source(ctx context.Context, sourceID string) (*store.Source, error) {
	if sourceID == "" {
		return nil, nil
	}
	return s.Repo.Source(ctx, sourceID)
}

// promptVersion is the normalizer's current prompt, or empty when there is no
// normalizer to have one.
// written puts every name the way we write names, dropping any that turns out
// to be a form of address and nothing else.
func written(raw []string) []string {
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, r := range raw {
		n := domain.Name(r)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// scriptOf is which script reads a source. Empty means the source's own id,
// which is how a source named after its script has always worked and is what
// keeps idt and audioveda running untouched.
func scriptOf(src *store.Source, sourceID string) string {
	if src != nil && src.Script != "" {
		return src.Script
	}
	return sourceID
}

// scriptVersion is which version of this source's own script read the page.
// It sits beside the prompt version in the skip test for the same reason:
// correcting how a source is read must re-read that source, and until this was
// here, editing a script changed nothing that had already been stored.
// readWithCurrentTools reports whether this page was last read with the prompt
// and the script we would read it with now.
func (s *Service) readWithCurrentTools(page *store.Page, src *store.Source, scriptID string) bool {
	return page.NormPromptVersion == s.promptVersion(src) &&
		page.ScriptVersion == s.scriptVersion(scriptID)
}

func (s *Service) scriptVersion(sourceID string) string {
	return s.Scripts.Version(sourceID)
}

// stated reports whether this archive publishes its own facts, so no model is
// asked about it.
func stated(src *store.Source) bool {
	return src != nil && src.Kind == store.KindStated
}

// promptVersion is the prompt this page would be read with now, empty where no
// prompt is involved. It is a fetch validator, and a prompt cannot change what
// a server sends — so a stated source must not carry one.
func (s *Service) promptVersion(src *store.Source) string {
	if s.Normalizer == nil || stated(src) {
		return ""
	}
	return s.Normalizer.PromptVersion()
}

// savePage records the visit, but not the proof that it succeeded.
//
// The three validators — the hash of the body, the hash of the file set, and
// the prompt version — are deliberately left empty here and written by
// MarkPageIndexed once the recordings are stored. SavePage coalesces an empty
// validator to whatever is already in the row, so an attempt that fails leaves
// the last complete pass's proof intact rather than replacing it with a claim
// this attempt did not earn.
func (s *Service) savePage(ctx context.Context, page *store.Page, resp *fetch.Response,
	src *store.Source, sourceID string, mediaFound int, now time.Time, report *Report) (int64, error) {

	min, max := recheckBounds(src)
	next := NextCheck(0, min, max, now)
	report.NextCheckAt = next
	p := &store.Page{
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
	return s.Repo.SavePage(ctx, p)
}

// recordUnchanged notes that a visit found nothing new and pushes the next one
// further out.
func (s *Service) recordUnchanged(ctx context.Context, page *store.Page, src *store.Source,
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
	min, max := recheckBounds(src)
	next := NextCheck(page.ConsecutiveUnchanged, min, max, now)
	page.NextCheckAt = &next
	page.Error = ""
	report.NextCheckAt = next
	// Nothing else to do: an unchanged page points where it pointed last time,
	// and its links are already stored.
	_, err := s.Repo.SavePage(ctx, page)
	return err
}

// recheckBounds is how often this source wants its pages read again. A source
// we know nothing about gets the service defaults rather than no bound at all.
func recheckBounds(src *store.Source) (time.Duration, time.Duration) {
	if src == nil {
		return DefaultRecheckMin, DefaultRecheckMax
	}
	return time.Duration(src.RecheckMinS) * time.Second,
		time.Duration(src.RecheckMaxS) * time.Second
}

func sourceIDOf(p *store.Page) string {
	if p == nil || p.SourceID == nil {
		return ""
	}
	return *p.SourceID
}

// recordFailure stores why a page could not be read, so a persistent problem
// is visible instead of showing up as a page that simply never updates.
func (s *Service) recordFailure(ctx context.Context, page *store.Page, src *store.Source,
	url, sourceID string, cause error, now time.Time) error {

	s.Metrics.Failure(fetch.Kind(cause))
	fails := 1
	if page != nil {
		fails = page.ConsecutiveFailures + 1
	}
	// The retry backs off the same way a page that never changes does, and
	// stops at the source's own ceiling. An address that has been gone for
	// years is not worth asking for twenty four times a day.
	_, max := recheckBounds(src)
	next := RetryAt(fails, max, now)
	p := &store.Page{
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
	if _, err := s.Repo.SavePage(ctx, p); err != nil {
		return fmt.Errorf("%w (and recording it failed: %v)", cause, err)
	}
	return cause
}

// record writes everything the page yielded.
//
// The three steps are gathered here so that a failure in any of them takes one
// path out of Item: the page is marked failed, and the proof that it was read
// is not written.
func (s *Service) record(ctx context.Context, e *domain.Extraction, pageID int64,
	sourceID string, src *store.Source, scriptID string, body []byte, force bool, now time.Time, report *Report) error {

	if err := s.storeItems(ctx, e, pageID, sourceID, src, scriptID, body, force, now, report); err != nil {
		return err
	}
	if err := s.markVanished(ctx, e, pageID, now, report); err != nil {
		return err
	}
	return s.storePageLinks(ctx, pageID, e.Links)
}

// storeItems writes every file the page offered, normalizing and embedding
// only the ones whose input actually changed.
func (s *Service) storeItems(ctx context.Context, e *domain.Extraction, pageID int64,
	sourceID string, src *store.Source, scriptID string, body []byte, force bool, now time.Time, report *Report) error {

	if len(e.Items) == 0 {
		return nil
	}
	fromScript := s.runScript(ctx, e, scriptID, body)
	batch := normalize.BatchFor(e)
	// What the archive printed, for every file: never the model's to answer.
	archived := make([]printed, len(e.Items))
	// Before the hash, not after: the material is part of what the model is
	// shown, so a script that starts handing over a video's title must make
	// every recording on that source unread again.
	for i := range batch.Items {
		if f, ok := fromScript[batch.Items[i].MediaURL]; ok {
			batch.Items[i].Material = f.Material
			archived[i] = scriptPrinted(f)
		}
	}
	// A stated source names no prompt and no model, so it needs neither one
	// configured to be read.
	byScript := stated(src)
	version, model := "", ""
	if s.Normalizer != nil && !byScript {
		version, model = s.Normalizer.PromptVersion(), s.Normalizer.Model()
	}

	existing := make([]*store.Item, len(e.Items))
	hashes := make([]string, len(e.Items))
	var todo []int
	for i := range e.Items {
		prior, err := s.Repo.ItemByMediaURL(ctx, e.Items[i].MediaURL)
		if err != nil {
			return err
		}
		existing[i] = prior
		if s.Normalizer == nil && !byScript {
			continue
		}
		hashes[i] = normalize.InputHash(batch, i, version, model)
		if force || prior == nil || prior.NormInputSHA256 != hashes[i] {
			todo = append(todo, i)
		}
	}

	// One listing can offer thousands of files, and reading them all in one
	// visit is hundreds of calls end to end inside the timeout that bounds a
	// single page. What is over the limit is stored unread; the page is left
	// unread too, further down, so the next visit carries on from here.
	if len(todo) > maxItemsPerVisit {
		report.ItemsDeferred = len(todo) - maxItemsPerVisit
		todo = todo[:maxItemsPerVisit]
	}

	results := make([]normalize.Result, len(e.Items))
	var pending []chunkWork
	// fresh are the files this pass has an answer for, from whichever side.
	fresh := map[int]bool{}
	// texts are the prose an archive published about a recording — one entry per
	// language, because a source that writes its own subtitles writes them in
	// every language it has a translator for.
	texts := map[int][]script.Text{}
	for _, i := range todo {
		f, ok := fromScript[e.Items[i].MediaURL]
		if !ok {
			continue
		}
		r := scriptResult(f)
		// An entry is not an answer: a stated archive whose script read nothing
		// has not named this recording. Silence taken for an answer is stored as
		// the recording's own and stamped with a hash, which stops it being
		// asked about again.
		if byScript && r.Title == "" && r.Author == "" {
			continue
		}
		results[i] = r
		texts[i] = f.Words()
		if byScript {
			fresh[i] = true
			report.ItemsFromScript++
		}
	}
	if byScript {
		todo = nil
	}
	if len(todo) > 0 {
		sub := normalize.Batch{PageURL: batch.PageURL, PageTitle: batch.PageTitle}
		for _, i := range todo {
			sub.Items = append(sub.Items, batch.Items[i])
		}
		got, err := s.Normalizer.Normalize(ctx, sub)
		if err != nil {
			return err
		}
		if len(got) != len(todo) {
			return fmt.Errorf("normalizer returned %d results for %d files", len(got), len(todo))
		}
		for n, i := range todo {
			// A file the model passed over keeps whatever the script read and
			// loses its hash, so the next visit asks again. Silence written in
			// its place would be stored as the recording's own answer and
			// stamped with the input hash, which stops it being asked again.
			if got[n].Unanswered {
				hashes[i] = ""
				continue
			}
			// The model reads; the script collects. The one thing a material
			// script states rather than reads is the language of the words it
			// found, and a caption track naming its own language beats a
			// reading of a sentence.
			r := got[n]
			if lang := results[i].Language; lang != "" {
				r.Language = lang
			}
			if r.Date == "" {
				r.Date = results[i].Date
			}
			results[i] = r
			fresh[i] = true
			report.ItemsNormalized++
		}
	}

	for i, extracted := range e.Items {
		item, err := s.buildItem(extracted, existing[i], results[i], archived[i], hashes[i],
			fresh[i], byScript, pageID, sourceID, src, version, model, now)
		if err != nil {
			return err
		}
		isNew, err := s.Repo.SaveItem(ctx, item)
		if err != nil {
			return err
		}
		// The written name is resolved to a person, and the recording is linked
		// to them. More than one speaker is ordinary: a conversation, a joint
		// class, a festival lecture given by four people in turn.
		var authorIDs []int64
		for _, name := range item.Authors {
			id, err := s.Repo.ResolveAuthor(ctx, name)
			if err != nil {
				return err
			}
			if id != 0 {
				authorIDs = append(authorIDs, id)
			}
		}
		if err := s.Repo.SetItemAuthors(ctx, item.ID, authorIDs); err != nil {
			return err
		}
		if err := s.Repo.ReplaceItemRefs(ctx, item.ID, item.References, store.OriginCrawl); err != nil {
			return err
		}
		if err := s.linkCollection(ctx, item, sourceID); err != nil {
			return err
		}
		if isNew {
			report.ItemsNew++
			fresh[i] = true
		}
		if !fresh[i] && !force {
			continue
		}
		// Prose is only replaced by prose somebody read. A script that failed
		// returns nothing for every file on the page at once, and storing that
		// empties the transcript and the chunks cut from it.
		if _, read := texts[i]; read || !s.hasScript(scriptID) {
			if err := s.Repo.ReplaceItemTexts(ctx, item.ID, store.ChunkPageText, itemTexts(texts[i])); err != nil {
				return err
			}
		}
		pending = append(pending, chunkWork{item: item, extracted: extracted, texts: texts[i]})
	}

	n, err := s.indexChunks(ctx, pending, sourceID)
	if err != nil {
		return err
	}
	report.ChunksIndexed += n
	return nil
}

// chunkWork is one recording waiting to be embedded, held back so that a whole
// page goes to the embedder at once.
type chunkWork struct {
	item      *store.Item
	extracted domain.Item
	// texts is prose the archive published, already Markdown, one per language.
	texts []script.Text
}

// itemTexts turns what a script said into what the store keeps. The two types
// stay apart on purpose: one is the vocabulary a script writes in, the other is
// a table.
func itemTexts(texts []script.Text) []store.ItemText {
	out := make([]store.ItemText, 0, len(texts))
	for _, t := range texts {
		out = append(out, store.ItemText{Lang: t.Lang, Text: t.Text})
	}
	return out
}

// linkCollection joins a recording to the cycle its own source named.
//
// The name comes from the archive's own words about that recording, rather
// than from anybody deciding that a set of links looks like a course.
func (s *Service) linkCollection(ctx context.Context, item *store.Item, sourceID string) error {
	if item.CollectionTitle == "" {
		return nil
	}
	placed, err := s.Repo.ItemHasCollection(ctx, item.ID)
	if err != nil || placed {
		return err
	}
	existing, err := s.Repo.CollectionByTitle(ctx, sourceID, item.CollectionTitle, item.Author)
	if err != nil {
		return err
	}
	if existing == nil {
		existing = &store.Collection{
			SourceID: sourceID,
			Title:    item.CollectionTitle,
			Author:   item.Author,
		}
		if err := s.Repo.SaveCollection(ctx, existing); err != nil {
			return err
		}
	}
	return s.Repo.AddMember(ctx, existing.ID, item.ID)
}

// buildItem merges what extraction found with what the normalizer said,
// falling back to what we already knew when nothing was re-normalized.
// scriptSource is what stands where a model's name would, for a recording the
// source's own script accounted for.
const scriptSource = "script"

func (s *Service) buildItem(extracted domain.Item, prior *store.Item, result normalize.Result,
	archived printed, hash string, normalized, byScript bool, pageID int64, sourceID string, src *store.Source,
	version, model string, seenAt time.Time) (*store.Item, error) {

	raw, err := json.Marshal(extracted)
	if err != nil {
		return nil, err
	}
	item := &store.Item{
		MediaURL:    extracted.MediaURL,
		PageID:      &pageID,
		Raw:         raw,
		MediaState:  store.MediaPresent,
		MediaSeenAt: &seenAt,
		Status:      store.StatusDiscovered,
	}
	if sourceID != "" {
		item.SourceID = &sourceID
	}
	if prior != nil {
		item.ID = prior.ID
	}

	switch {
	case normalized:
		item.CollectionTitle = archived.CollectionTitle
		item.Title = result.Title
		// The same settling the script path does. Without it a speaker read by
		// the model is stored as "HH Radhanath Swami" and one read by a script
		// as "Radhanath Swami", and the two disagree in every list that shows
		// the name -- while grouping quietly works, because the key is computed
		// separately and hides the difference.
		item.Author = domain.Name(result.Author)
		item.Authors = written(result.Authors)
		if len(item.Authors) == 0 && item.Author != "" {
			item.Authors = []string{item.Author}
		}
		item.Location = domain.Place(result.Location)
		item.Language, item.DurationS = result.Language, archived.DurationS
		item.CoverURL = archived.CoverURL
		item.RecordedOn = parseDate(result.Date)
		item.References = result.References
		// A stated archive names its talk and no model reads that name, so which
		// scripture it cites is settled here — the same corpus vocabulary that
		// settles a stated author's spelling.
		if byScript && len(item.References) == 0 {
			for _, c := range domain.Cites(item.Title) {
				expanded, _ := domain.ExpandRefs(c.Ref.Source, c.Ref.Tokens)
				item.References = append(item.References, expanded...)
			}
		}
		item.NormInputSHA256, item.NormPromptVersion, item.NormModel = hash, version, model
		if byScript {
			// Nothing was asked of a model, so nothing names one. Recording the
			// configured model here would put a cost against a call that never
			// happened.
			item.NormModel, item.NormPromptVersion = scriptSource, ""
		}
		item.Status = store.StatusNormalized
	case prior != nil:
		item.CollectionTitle = prior.CollectionTitle
		item.Title, item.Author, item.Location = prior.Title, prior.Author, prior.Location
		item.Authors = prior.Authors
		item.Language, item.DurationS, item.RecordedOn = prior.Language, prior.DurationS, prior.RecordedOn
		item.CoverURL = prior.CoverURL
		item.References = prior.References
		item.NormInputSHA256 = prior.NormInputSHA256
		item.NormPromptVersion, item.NormModel = prior.NormPromptVersion, prior.NormModel
		item.Status = prior.Status
	}

	// Last, and it wins. Somebody setting this knows whose archive they pointed
	// us at, and that beats anything read off the page.
	//
	// It had to win. As a fallback it never fired: a source script fills the
	// author in from the channel name for every video, so nothing fell through
	// to it — and what it fell through to was wrong, four hundred lectures by
	// forty people filed under the name of a temple.
	//
	// Which is why it is empty by default and must stay empty on a channel that
	// carries guests: it is an assertion, and asserting it where it is not true
	// is worse than leaving the question open.
	if src != nil && src.AuthorOverride != "" {
		if named := domain.Name(src.AuthorOverride); named != "" {
			item.Author = named
			item.Authors = []string{named}
		}
	}
	return item, nil
}

// indexChunks embeds what is searchable about a page's recordings, in one
// request for the whole page and skipping whatever has been embedded before.
//
// Only the title. The speaker, the date and the references are exact filters
// living in columns, and folding them into the vector only blurs what it is
// about; the text around a link on a file listing is the site's menu and the
// names of the neighbouring files.
//
// A page of forty nine files was making forty nine round trips of a few seconds
// each, so a page needing one model call took three minutes. The embedder takes
// a list and always did.
func (s *Service) indexChunks(ctx context.Context, work []chunkWork, sourceID string) (int, error) {
	if s.Embedder == nil || len(work) == 0 {
		return 0, nil
	}

	// One page repeats a title many times — one listing carried twenty nine
	// "Hare Krishna Kirtan" — so the same words are embedded once.
	// Everything this page wants embedded, in order, with the repeats taken out:
	// one listing carried twenty nine "Hare Krishna Kirtan".
	plan := make([][]store.Chunk, len(work))
	var wanted []string
	seen := map[string]bool{}
	want := func(text string) {
		if text == "" || seen[text] {
			return
		}
		seen[text] = true
		wanted = append(wanted, text)
	}
	for i, w := range work {
		if title := strings.TrimSpace(w.item.Title); title != "" {
			plan[i] = append(plan[i], store.Chunk{
				ItemID: w.item.ID, Kind: store.ChunkTitle,
				Lang: w.item.Language, Text: title,
			})
			want(title)
		}
		// Each language is cut up separately and its pieces carry its name, so a
		// hit can say which transcript it came from. The ordinal restarts per
		// language: it places a piece within its own text, and running it on
		// across two languages would say a Russian passage follows an English
		// one, which is not a thing that happened.
		for _, text := range w.texts {
			for n, part := range Chunks(text.Text) {
				plan[i] = append(plan[i], store.Chunk{
					ItemID: w.item.ID, Kind: store.ChunkPageText,
					Lang: text.Lang, Ordinal: n, Text: part,
				})
				want(part)
			}
		}
	}
	if len(wanted) == 0 {
		return 0, nil
	}

	model := s.Embedder.Model()
	vectors, err := s.Repo.CachedEmbeddings(ctx, model, wanted)
	if err != nil {
		return 0, err
	}
	if vectors == nil {
		vectors = map[string][]float32{}
	}

	var missing []string
	for _, text := range wanted {
		if _, ok := vectors[text]; !ok {
			missing = append(missing, text)
		}
	}
	if len(missing) > 0 {
		got, err := s.Embedder.Embed(ctx, missing)
		if err != nil {
			return 0, err
		}
		if len(got) != len(missing) {
			return 0, fmt.Errorf("embedder returned %d vectors for %d texts", len(got), len(missing))
		}
		fresh := make(map[string][]float32, len(missing))
		for i, text := range missing {
			vectors[text] = got[i]
			fresh[text] = got[i]
		}
		if err := s.Repo.SaveEmbeddings(ctx, model, fresh); err != nil {
			return 0, err
		}
		// Embedding is the larger half of what this service spends — roughly
		// five dollars against the normalizer's one, over the corpus as it
		// stands — and it was counted nowhere. The provider reports tokens and
		// a price on every answer; nobody had read the body.
		s.Metrics.Embedded(len(missing))
		for _, sp := range s.Embedder.Spent() {
			if err := s.Repo.RecordSpend(ctx, store.Spend{
				SourceID: sourceID, Kind: "embed", Model: sp.Model, Items: sp.Items,
				TokensIn: sp.Tokens, CostUSD: sp.CostUSD,
			}); err != nil {
				slog.WarnContext(ctx, "embed_spend_not_recorded", "source", sourceID, "err", err.Error())
			}
			if sp.CostUSD != nil {
				s.Metrics.Spend(*sp.CostUSD)
			}
		}
	}

	total := 0
	for i, w := range work {
		for n := range plan[i] {
			plan[i][n].Embedding = vectors[plan[i][n].Text]
		}
		// A recording the archive never named and wrote nothing about keeps no
		// chunks at all. It is still found by its speaker, its date and the
		// verses it covers.
		if err := s.Repo.ReplaceItemChunks(ctx, w.item.ID, plan[i]); err != nil {
			return total, err
		}
		total += len(plan[i])
	}
	return total, nil
}

func parseDate(s string) *time.Time {
	if s == "" {
		return nil
	}
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil
	}
	return &d
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

// Rechunk cuts the prose already stored into chunks again and embeds what is
// new, without fetching anything or calling a model.
//
// It is what makes changing the cut a local decision: the text is in the
// database, and the embedding cache is keyed by the text, so only pieces that
// actually changed are bought.
func (s *Service) Rechunk(ctx context.Context, sourceID string, batch int) (int, error) {
	if batch <= 0 {
		batch = 200
	}
	var after int64
	var total int
	for {
		items, err := s.Repo.ItemsAfter(ctx, sourceID, after, batch)
		if err != nil {
			return total, err
		}
		if len(items) == 0 {
			return total, nil
		}
		work := make([]chunkWork, 0, len(items))
		for i := range items {
			item := &items[i]
			after = item.ID
			texts, err := s.Repo.ItemTexts(ctx, item.ID, store.ChunkPageText)
			if err != nil {
				return total, err
			}
			said := make([]script.Text, 0, len(texts))
			for _, t := range texts {
				said = append(said, script.Text{Lang: t.Lang, Text: t.Text})
			}
			work = append(work, chunkWork{item: item, texts: said})
		}
		n, err := s.indexChunks(ctx, work, sourceID)
		if err != nil {
			return total, err
		}
		total += n
	}
}

// hasScript reports whether this source is read by one, which is what makes a
// missing answer meaningful rather than expected.
func (s *Service) hasScript(scriptID string) bool {
	return s.Scripts != nil && s.Scripts.Has(scriptID)
}

// maxItemsPerVisit is how many files one visit to a page may read. Five calls
// at the batch size, which leaves the rest of a page's timeout to the
// embedding and the writes.
const maxItemsPerVisit = 200
