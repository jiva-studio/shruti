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
	"sort"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/extract"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// Fetcher is the polite HTTP client, narrowed to what indexing needs.
type Fetcher interface {
	Get(ctx context.Context, url string, req fetch.Request) (*fetch.Response, error)
}

// Embedder turns text into vectors. Nil leaves items stored but unsearchable
// by meaning, which is a degraded service rather than a broken one.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Model() string
}

// Service indexes one URL at a time. The crawl loop is just this in a loop.
type Service struct {
	Fetcher    Fetcher
	Normalizer normalize.Normalizer
	Embedder   Embedder
	Repo       *store.Repo
	Now        func() time.Time
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
	FinalURL        string    `json:"final_url,omitempty"`
	Status          int       `json:"status,omitempty"`
	NotModified     bool      `json:"not_modified,omitempty"`
	Unchanged       bool      `json:"unchanged,omitempty"`
	PageID          int64     `json:"page_id,omitempty"`
	ItemsFound      int       `json:"items_found"`
	ItemsNew        int       `json:"items_new"`
	ItemsNormalized int       `json:"items_normalized"`
	ChunksIndexed   int       `json:"chunks_indexed"`
	MediaVanished   int       `json:"media_vanished,omitempty"`
	Collection      string    `json:"collection,omitempty"`
	Links           []string  `json:"-"`
	NextCheckAt     time.Time `json:"next_check_at"`
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
	if page != nil && !force {
		req.ETag, req.LastModified = page.ETag, page.LastModified
	}
	// A source whose media sits behind an account only shows the address of the
	// file to someone signed in, so its credentials ride along — and so does
	// the gap it asked to be left between requests.
	src, err := s.source(ctx, sourceID)
	if err != nil {
		return nil, err
	}
	if src != nil {
		req.Headers = src.AuthHeaders
		req.MinDelay = time.Duration(src.CrawlDelayMS) * time.Millisecond
	}

	resp, err := s.Fetcher.Get(ctx, rawURL, req)
	if err != nil {
		return nil, s.recordFailure(ctx, page, rawURL, sourceID, err, now)
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
		return report, s.recordUnchanged(ctx, page, report, now)
	}

	extraction, err := extract.Parse(resp.Body, resp.ContentType, resp.URL)
	if err != nil {
		return nil, s.recordFailure(ctx, page, rawURL, sourceID, err, now)
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
		page.NormPromptVersion == s.promptVersion()
	if unchanged && !force {
		return report, s.recordUnchanged(ctx, page, report, now)
	}

	pageID, err := s.savePage(ctx, page, resp, sourceID, itemSet, len(extraction.Items), now, report)
	if err != nil {
		return nil, err
	}
	report.PageID = pageID

	if err := s.storeItems(ctx, extraction, pageID, sourceID, force, now, report); err != nil {
		return nil, err
	}
	if err := s.markVanished(ctx, extraction, pageID, now, report); err != nil {
		return nil, err
	}
	if err := s.storeSeries(ctx, pageID, extraction.Links, len(extraction.Items),
		extraction.PageTitle, extraction.PageText, sourceID, report); err != nil {
		return nil, err
	}
	return report, nil
}

// minSeriesParts is the fewest recordings a cycle can be made of. One is not a
// series; it is a page with a recording on it.
const minSeriesParts = 2

// storeSeries records what a page pointed at and asks whether a page that
// offered no audio presents a cycle.
//
// The links are kept for every page, whether or not it carried audio. They are
// the raw material for deciding about a cycle later, and they are also the only
// way the crawl can walk through a page whose recheck has not come around
// without asking the host for it again.
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

	// A cycle this page already defines absorbs any that its parts built by
	// name in the meantime. That is a join, not a judgement, so it does not
	// wait on asking the model anything — a duplicate appearing later would
	// otherwise sit there until the page happened to be asked again.
	if page != nil {
		known, err := s.Repo.CollectionByURL(ctx, sourceID, page.URL)
		if err != nil {
			return err
		}
		if known != nil {
			if err := s.Repo.AbsorbByTitle(ctx, known.ID, sourceID, known.Title, known.Author); err != nil {
				return err
			}
		}
	}

	known, err := s.Repo.KnownMediaLinks(ctx, links)
	if err != nil {
		return err
	}
	if known < minSeriesParts || (page != nil && known <= page.SeriesLinksSeen) {
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
func (s *Service) promptVersion() string {
	if s.Normalizer == nil {
		return ""
	}
	return s.Normalizer.PromptVersion()
}

func (s *Service) savePage(ctx context.Context, page *store.Page, resp *fetch.Response,
	sourceID, itemSet string, mediaFound int, now time.Time, report *Report) (int64, error) {

	next := NextCheck(0, now)
	report.NextCheckAt = next
	p := &store.Page{
		URL:                  resp.URL,
		ETag:                 resp.ETag,
		LastModified:         resp.LastModified,
		BodySHA256:           resp.BodySHA256,
		ItemSetSHA256:        itemSet,
		HTTPStatus:           resp.Status,
		LastFetchedAt:        &now,
		LastChangedAt:        &now,
		ConsecutiveUnchanged: 0,
		NextCheckAt:          &next,
		NormPromptVersion:    s.promptVersion(),
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
func (s *Service) recordUnchanged(ctx context.Context, page *store.Page, report *Report, now time.Time) error {
	report.NotModified = true
	report.Unchanged = true
	if page == nil {
		return nil
	}
	page.ConsecutiveUnchanged++
	page.LastFetchedAt = &now
	next := NextCheck(page.ConsecutiveUnchanged, now)
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

func sourceIDOf(p *store.Page) string {
	if p == nil || p.SourceID == nil {
		return ""
	}
	return *p.SourceID
}

// recordFailure stores why a page could not be read, so a persistent problem
// is visible instead of showing up as a page that simply never updates.
func (s *Service) recordFailure(ctx context.Context, page *store.Page, url, sourceID string, cause error, now time.Time) error {
	next := RetryAt(now)
	p := &store.Page{
		URL:           url,
		Error:         cause.Error(),
		LastFetchedAt: &now,
		NextCheckAt:   &next,
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

// storeItems writes every file the page offered, normalizing and embedding
// only the ones whose input actually changed.
func (s *Service) storeItems(ctx context.Context, e *domain.Extraction, pageID int64,
	sourceID string, force bool, now time.Time, report *Report) error {

	if len(e.Items) == 0 {
		return nil
	}
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
			results[i] = got[n]
		}
		report.ItemsNormalized = len(todo)
	}

	reindex := map[int]bool{}
	for _, i := range todo {
		reindex[i] = true
	}

	for i, extracted := range e.Items {
		item, err := s.buildItem(extracted, existing[i], results[i], hashes[i],
			reindex[i], pageID, sourceID, version, model, now)
		if err != nil {
			return err
		}
		isNew, err := s.Repo.SaveItem(ctx, item)
		if err != nil {
			return err
		}
		if err := s.Repo.ReplaceItemRefs(ctx, item.ID, item.References); err != nil {
			return err
		}
		if err := s.linkCollection(ctx, item, e.URL, sourceID); err != nil {
			return err
		}
		if isNew {
			report.ItemsNew++
			reindex[i] = true
		}
		if !reindex[i] && !force {
			continue
		}
		n, err := s.indexChunks(ctx, item, extracted, pageID, sourceID)
		if err != nil {
			return err
		}
		report.ChunksIndexed += n
	}
	return nil
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
func (s *Service) buildItem(extracted domain.Item, prior *store.Item, result normalize.Result,
	hash string, normalized bool, pageID int64, sourceID, version, model string, seenAt time.Time) (*store.Item, error) {

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
		item.Title, item.Author, item.Location = result.Title, result.Author, result.Location
		item.Language, item.DurationS = result.Language, result.DurationS
		item.RecordedOn = parseDate(result.Date)
		item.References = result.References
		item.NormInputSHA256, item.NormPromptVersion, item.NormModel = hash, version, model
		item.Status = store.StatusNormalized
	case prior != nil:
		item.CollectionTitle = prior.CollectionTitle
		item.Title, item.Author, item.Location = prior.Title, prior.Author, prior.Location
		item.Language, item.DurationS, item.RecordedOn = prior.Language, prior.DurationS, prior.RecordedOn
		item.References = prior.References
		item.NormInputSHA256 = prior.NormInputSHA256
		item.NormPromptVersion, item.NormModel = prior.NormPromptVersion, prior.NormModel
		item.Status = prior.Status
	}
	return item, nil
}

// indexChunks re-embeds one item's searchable text.
//
// The first chunk is the metadata line — speaker, place, date, reference —
// because that is what people actually search for, and it appears nowhere in
// the page prose on a file listing.
func (s *Service) indexChunks(ctx context.Context, item *store.Item, extracted domain.Item,
	pageID int64, sourceID string) (int, error) {

	if s.Embedder == nil {
		return 0, nil
	}
	texts := []string{}
	if line := metadataLine(item, extracted); line != "" {
		texts = append(texts, line)
	}
	texts = append(texts, Chunks(extracted.ContextText)...)
	if len(texts) == 0 {
		return 0, nil
	}

	vectors, err := s.Embedder.Embed(ctx, texts)
	if err != nil {
		return 0, err
	}
	role := string(extracted.TextRole)
	if role == "" {
		role = string(domain.TextShared)
	}

	chunks := make([]store.Chunk, len(texts))
	for i := range texts {
		c := store.Chunk{
			ItemID:    &item.ID,
			PageID:    &pageID,
			Language:  item.Language,
			Role:      role,
			Ordinal:   i,
			Text:      texts[i],
			Embedding: vectors[i],
		}
		if sourceID != "" {
			c.SourceID = &sourceID
		}
		chunks[i] = c
	}
	if err := s.Repo.ReplaceItemChunks(ctx, item.ID, chunks); err != nil {
		return 0, err
	}
	return len(chunks), nil
}

func metadataLine(item *store.Item, extracted domain.Item) string {
	parts := []string{}
	for _, v := range []string{item.Title, item.Author, item.Location} {
		if v != "" {
			parts = append(parts, v)
		}
	}
	if item.RecordedOn != nil {
		parts = append(parts, item.RecordedOn.Format("2006-01-02"))
	}
	for i, ref := range item.References {
		if i == refsInLine {
			parts = append(parts, fmt.Sprintf("+%d more", len(item.References)-refsInLine))
			break
		}
		parts = append(parts, ref.Label())
	}
	if len(parts) == 0 {
		parts = append(parts, extracted.Filename)
	}
	return strings.Join(parts, " — ")
}

// refsInLine caps how many passages go into the line that gets embedded.
//
// A talk on a whole chapter is filed as a range and expands to every verse in
// it: one recording carried thirty-seven, and the sentence describing it was
// nine tenths "SB 10.33.n". The vector then says almost nothing about the talk.
// Every reference is still stored and still searchable by itself — this is
// only what the sentence says out loud.
const refsInLine = 3

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
