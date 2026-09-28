package sqlitelibrary

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

func (s *Store) GetVerse(ctx context.Context, sourceID, tokens string) (library.Verse, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return library.Verse{}, false, err
	}
	defer release()
	return r.GetVerse(ctx, sourceID, tokens)
}

func (s *Store) GetVerseByID(ctx context.Context, id string) (library.Verse, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return library.Verse{}, false, err
	}
	defer release()
	return r.GetVerseByID(ctx, id)
}

func (s *Store) ListVerses(ctx context.Context, opts library.ListVersesOpts) ([]library.Verse, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListVerses(ctx, opts)
}

func (s *Store) GetDocument(ctx context.Context, id string) (library.Document, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return library.Document{}, false, err
	}
	defer release()
	return r.GetDocument(ctx, id)
}

func (s *Store) ListDocuments(ctx context.Context, opts library.ListDocumentsOpts) ([]library.Document, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListDocuments(ctx, opts)
}

func (s *Store) GetTitle(ctx context.Context, sourceID, tokens, language string) (string, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return "", false, err
	}
	defer release()
	return r.GetTitle(ctx, sourceID, tokens, language)
}

func (s *Store) ListTitles(ctx context.Context, opts library.ListTitlesOpts) ([]library.Title, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListTitles(ctx, opts)
}

// ---------- ATTRIBUTION ----------

func (s *Store) AttributionCreate(ctx context.Context, id string, kind library.AttributionKind, language, firstText string) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionCreate(ctx, id, kind, language, firstText)
}

func (s *Store) AttributionFindByText(ctx context.Context, kind library.AttributionKind, language, text string) (string, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return "", false, err
	}
	defer release()
	return r.AttributionFindByText(ctx, kind, language, text)
}

func (s *Store) AttributionGet(ctx context.Context, id string) (library.Attribution, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return library.Attribution{}, false, err
	}
	defer release()
	return r.AttributionGet(ctx, id)
}

func (s *Store) AttributionList(ctx context.Context, opts library.ListAttributionsOpts) ([]library.Attribution, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.AttributionList(ctx, opts)
}

func (s *Store) AttributionTextAdd(ctx context.Context, id, language, text string) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionTextAdd(ctx, id, language, text)
}

func (s *Store) AttributionTextRemove(ctx context.Context, id, language, text string) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionTextRemove(ctx, id, language, text)
}

func (s *Store) AttributionNoteSet(ctx context.Context, id, language, note string) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionNoteSet(ctx, id, language, note)
}

func (s *Store) AttributionNoteRemove(ctx context.Context, id, language string) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionNoteRemove(ctx, id, language)
}

func (s *Store) AttributionRefAdd(ctx context.Context, id string, ref library.AttributionRef) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionRefAdd(ctx, id, ref)
}

func (s *Store) AttributionRefRemove(ctx context.Context, id string, ref library.AttributionRef) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionRefRemove(ctx, id, ref)
}

func (s *Store) AttributionDelete(ctx context.Context, id string) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.AttributionDelete(ctx, id)
}

// ---------- MEDIA ----------

func (s *Store) MediaUpsert(ctx context.Context, m library.Media) error {
	r, release, err := s.acquireForWrite(ctx)
	if err != nil {
		return err
	}
	defer release()
	return r.MediaUpsert(ctx, m)
}
