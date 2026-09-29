package index

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

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

// record writes everything the page yielded.
//
// The three steps are gathered here so that a failure in any of them takes one
// path out of Item: the page is marked failed, and the proof that it was read
// is not written.
func (s *Service) record(ctx context.Context, e *domain.Extraction, pageID int64,
	sourceID string, src *domain.Archive, scriptID string, body []byte, force bool, now time.Time, report *Report) error {

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
	sourceID string, src *domain.Archive, scriptID string, body []byte, force bool, now time.Time, report *Report) error {

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

	existing := make([]*domain.Recording, len(e.Items))
	hashes := make([]string, len(e.Items))
	var todo []int
	for i := range e.Items {
		prior, err := s.Store.ItemByMediaURL(ctx, e.Items[i].MediaURL)
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
		isNew, err := s.Store.SaveItem(ctx, item)
		if err != nil {
			return err
		}
		// The written name is resolved to a person, and the recording is linked
		// to them. More than one speaker is ordinary: a conversation, a joint
		// class, a festival lecture given by four people in turn.
		var authorIDs []int64
		for _, name := range item.Authors {
			id, err := s.Store.ResolveAuthor(ctx, name)
			if err != nil {
				return err
			}
			if id != 0 {
				authorIDs = append(authorIDs, id)
			}
		}
		if err := s.Store.SetItemAuthors(ctx, item.ID, authorIDs); err != nil {
			return err
		}
		if err := s.Store.ReplaceItemRefs(ctx, item.ID, item.References, domain.OriginCrawl); err != nil {
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
			if err := s.Store.ReplaceItemTexts(ctx, item.ID, domain.ChunkPageText, itemTexts(texts[i])); err != nil {
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

// itemTexts turns what a script said into what the store keeps. The two types
// stay apart on purpose: one is the vocabulary a script writes in, the other is
// a table.
func itemTexts(texts []script.Text) []domain.ItemText {
	out := make([]domain.ItemText, 0, len(texts))
	for _, t := range texts {
		out = append(out, domain.ItemText{Lang: t.Lang, Text: t.Text})
	}
	return out
}

// linkCollection joins a recording to the cycle its own source named.
//
// The name comes from the archive's own words about that recording, rather
// than from anybody deciding that a set of links looks like a course.
func (s *Service) linkCollection(ctx context.Context, item *domain.Recording, sourceID string) error {
	if item.CollectionTitle == "" {
		return nil
	}
	placed, err := s.Store.ItemHasCollection(ctx, item.ID)
	if err != nil || placed {
		return err
	}
	existing, err := s.Store.CollectionByTitle(ctx, sourceID, item.CollectionTitle, item.Author)
	if err != nil {
		return err
	}
	if existing == nil {
		existing = &domain.Collection{
			SourceID: sourceID,
			Title:    item.CollectionTitle,
			Author:   item.Author,
		}
		if err := s.Store.SaveCollection(ctx, existing); err != nil {
			return err
		}
	}
	return s.Store.AddMember(ctx, existing.ID, item.ID)
}

// scriptSource is what stands where a model's name would, for a recording the
// source's own script accounted for.
const scriptSource = "script"

// buildItem merges what extraction found with what the normalizer said,
// falling back to what we already knew when nothing was re-normalized.
func (s *Service) buildItem(extracted domain.Item, prior *domain.Recording, result normalize.Result,
	archived printed, hash string, normalized, byScript bool, pageID int64, sourceID string, src *domain.Archive,
	version, model string, seenAt time.Time) (*domain.Recording, error) {

	raw, err := json.Marshal(extracted)
	if err != nil {
		return nil, err
	}
	item := &domain.Recording{
		MediaURL:    extracted.MediaURL,
		PageID:      &pageID,
		Raw:         raw,
		MediaState:  domain.MediaPresent,
		MediaSeenAt: &seenAt,
		Status:      domain.StatusDiscovered,
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
		item.Status = domain.StatusNormalized
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
	// It has to win. As a fallback it would never fire: a source script fills
	// the author in from the channel name for every video, so nothing falls
	// through to it — and a channel name can be a temple's, filing lectures by
	// many people under it.
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

// maxItemsPerVisit is how many files one visit to a page may read. Five calls
// at the batch size, which leaves the rest of a page's timeout to the
// embedding and the writes.
const maxItemsPerVisit = 200
