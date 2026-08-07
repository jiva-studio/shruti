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

	"github.com/jiva-studio/lectorium/discovery/internal/application/normalize"
	"github.com/jiva-studio/lectorium/discovery/internal/application/script"
	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"github.com/jiva-studio/lectorium/discovery/internal/extract"
	"github.com/jiva-studio/lectorium/discovery/internal/infra/embed"
	"github.com/jiva-studio/lectorium/discovery/internal/infra/fetch"
	"github.com/jiva-studio/lectorium/discovery/internal/metrics"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
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
	// AskedWhy counts, by reason, the files the script handed to the model.
	AskedWhy      map[string]int `json:"asked_why,omitempty"`
	MediaVanished int            `json:"media_vanished,omitempty"`
	Collection    string         `json:"collection,omitempty"`
	Links         []string       `json:"-"`
	NextCheckAt   time.Time      `json:"next_check_at"`
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
	// audioveda serves an ETag on 14,534 of its 14,586 pages, so editing its
	// script had no effect there at all.
	if page != nil && !force && s.readWithCurrentTools(page, scriptOf(src, sourceID)) {
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
		s.readWithCurrentTools(page, scriptID)
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
	if err := s.Repo.MarkPageIndexed(ctx, pageID, resp.BodySHA256, itemSet,
		s.promptVersion(), s.scriptVersion(scriptID)); err != nil {
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
		row := store.Spend{SourceID: sourceID, Kind: "normalize", Model: sp.Model, Items: sp.Items}
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

// minSeriesParts is the fewest recordings a cycle can be made of. One is not a
// series; it is a page with a recording on it.
const minSeriesParts = 2

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

// storeSeries records what a page pointed at, and asks whether a page that
// offered no audio presents a cycle. Links are kept for every page: they are
// what a cycle is decided from later, and how the crawl walks through a page it
// is not due to fetch.
//
// The question itself is only put when at least two of those links reach
// recordings we already have. Most pages on any site carry no audio: menus,
// sections, sign-in pages, the account pages of whoever we are signed in as.
// Asking each of them costs a model call to be told that a menu is a menu, and
// at archive scale that is the whole bill. A page whose links reach nothing we
// know is not a cycle, and the counter remembers what it reached when we last
// asked, so a menu is never asked twice and a page whose parts have since been
// found is asked again.
func (s *Service) storeSeries(ctx context.Context, pageID int64, links []string,
	mediaFound int, pageTitle, pageText, sourceID string, report *Report) error {

	links = s.fetchable(ctx, links)
	if len(links) > 0 {
		if err := s.Repo.ReplacePageLinks(ctx, pageID, links); err != nil {
			return err
		}
	} else {
		var err error
		if links, err = s.Repo.PageLinks(ctx, pageID); err != nil {
			return err
		}
	}
	if mediaFound > 0 {
		return nil
	}
	if s.Normalizer == nil || len(links) == 0 {
		return nil
	}

	page, err := s.Repo.PageByID(ctx, pageID)
	if err != nil {
		return err
	}
	// Everything below reads the page. A row that has gone — deleted while the
	// visit was in flight — is not worth failing the page for, but it is not
	// something to walk into either.
	if page == nil {
		return nil
	}

	// A cycle this page already defines absorbs any that its parts built by
	// name in the meantime. That is a join, not a judgement, so it does not
	// wait on asking the model anything — a duplicate appearing later would
	// otherwise sit there until the page happened to be asked again.
	if defined, err := s.Repo.CollectionByURL(ctx, sourceID, page.URL); err != nil {
		return err
	} else if defined != nil {
		if err := s.Repo.AbsorbByTitle(ctx, defined.ID, sourceID, defined.Title, defined.Author); err != nil {
			return err
		}
	}

	known, err := s.Repo.KnownMediaLinks(ctx, links)
	if err != nil {
		return err
	}
	if known < minSeriesParts || known <= page.SeriesLinksSeen {
		return nil
	}
	if err := s.Repo.SetSeriesLinksSeen(ctx, pageID, known); err != nil {
		return err
	}

	series, err := s.Normalizer.Series(ctx, normalize.SeriesInput{
		PageURL:   page.URL,
		PageTitle: pageTitle,
		PageText:  pageText,
		Links:     links,
	})
	if err != nil || series == nil {
		return err
	}

	collection := &store.Collection{
		SourceID:    sourceID,
		URL:         page.URL,
		Title:       series.Title,
		Description: series.Description,
		Author:      series.Author,
	}
	if err := s.Repo.SaveCollection(ctx, collection); err != nil {
		return err
	}
	if err := s.Repo.ReplaceMembers(ctx, collection.ID, series.Members); err != nil {
		return err
	}
	// Parts indexed before this page named the cycle themselves and were kept
	// under that name. Same cycle, so fold it in rather than leaving two.
	if err := s.Repo.AbsorbByTitle(ctx, collection.ID, sourceID, collection.Title, collection.Author); err != nil {
		return err
	}
	report.Collection = collection.Title
	return nil
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
func (s *Service) readWithCurrentTools(page *store.Page, scriptID string) bool {
	return page.NormPromptVersion == s.promptVersion() &&
		page.ScriptVersion == s.scriptVersion(scriptID)
}

func (s *Service) scriptVersion(sourceID string) string {
	return s.Scripts.Version(sourceID)
}

func (s *Service) promptVersion() string {
	if s.Normalizer == nil {
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
		LastChangedAt:        &now,
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
	if _, err := s.Repo.SavePage(ctx, page); err != nil {
		return err
	}
	// An unchanged visit has no body to quote from; the links it left behind
	// are enough for the question, and the question is only reached at all
	// once its parts have been found.
	return s.storeSeries(ctx, page.ID, nil, page.MediaFound, "", "", sourceIDOf(page), report)
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
	return s.storeSeries(ctx, pageID, e.Links, len(e.Items), e.PageTitle, e.PageText, sourceID, report)
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
	version, model := "", ""
	if s.Normalizer != nil {
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
		if s.Normalizer == nil {
			continue
		}
		hashes[i] = normalize.InputHash(batch, i, version, model)
		if force || prior == nil || prior.NormInputSHA256 != hashes[i] {
			todo = append(todo, i)
		}
	}

	results := make([]normalize.Result, len(e.Items))
	// What the script settled is settled. A file it accounted for in full is
	// dropped from the model's work: the call is the cost, and there is nothing
	// left to ask about.
	var pending []chunkWork
	// fresh are the files this pass has an answer for, from whichever side.
	// Both count: a file the script settled is as freshly known as one the
	// model just read, and treating only the model's as fresh would store the
	// script's work nowhere.
	fresh := map[int]bool{}
	// settled are the files no model was asked about.
	settled := map[int]bool{}
	// reasons record what stopped the script on the rest.
	reasons := map[int][]string{}
	// texts are the prose an archive published about a recording — one entry per
	// language, because a source that writes its own subtitles writes them in
	// every language it has a translator for.
	texts := map[int][]script.Text{}
	var ask []int
	for _, i := range todo {
		f, ok := fromScript[e.Items[i].MediaURL]
		if !ok {
			ask = append(ask, i)
			continue
		}
		results[i] = scriptResult(f)
		texts[i] = f.Words()
		fresh[i] = true
		if f.Complete {
			settled[i] = true
			report.ItemsFromScript++
			continue
		}
		reasons[i] = f.Reasons
		ask = append(ask, i)
	}
	todo = ask
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
			// The model's answer wins outright. A recording reaches it only
			// because the script declared it could not read the line, and a
			// parse its own author calls unreliable is not something to keep
			// half of: keeping it stored "Glories of Srimati rani" over the
			// model's correct reading.
			results[i] = got[n]
		}
		report.ItemsNormalized = len(todo)
	}

	for _, i := range todo {
		fresh[i] = true
	}

	for i, extracted := range e.Items {
		item, err := s.buildItem(extracted, existing[i], results[i], hashes[i],
			fresh[i], settled[i], pageID, sourceID, src, version, model, now)
		if err != nil {
			return err
		}
		item.NormReasons = reasons[i]
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
		if err := s.linkCollection(ctx, item, e.URL, sourceID); err != nil {
			return err
		}
		if isNew {
			report.ItemsNew++
			fresh[i] = true
		}
		if !fresh[i] && !force {
			continue
		}
		if err := s.Repo.ReplaceItemTexts(ctx, item.ID, store.ChunkPageText, itemTexts(texts[i])); err != nil {
			return err
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

// linkCollection joins a recording to its cycle from whichever side is
// available.
//
// A series page indexed earlier is waiting with this page's address and no
// recording against it; fill that in. Where no page lists the membership at
// all, the name the recording's own page gave the cycle is the only handle
// there is, so a collection is kept under that name.
func (s *Service) linkCollection(ctx context.Context, item *store.Item, pageURL, sourceID string) error {
	if err := s.Repo.ResolvePendingMembers(ctx, pageURL, item.ID); err != nil {
		return err
	}
	if item.CollectionTitle == "" {
		return nil
	}
	// A series page places its parts exactly. Only fall back to the name when
	// nothing has placed this one.
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
	hash string, normalized, byScript bool, pageID int64, sourceID string, src *store.Source,
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
		item.CollectionTitle = result.CollectionTitle
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
		// The model writes a location the way the page did — "ISKCON Chennai" —
		// and the organisation is no more part of the place than a form of
		// address is part of a name.
		item.Location = domain.Place(result.Location)
		item.Language, item.DurationS = result.Language, result.DurationS
		item.RecordedOn = parseDate(result.Date)
		item.References = result.References
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
