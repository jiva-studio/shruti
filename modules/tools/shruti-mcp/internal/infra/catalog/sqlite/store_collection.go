package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func (s *Store) CreateCollectionLocale(ctx context.Context, id, language, name, cover, description, meta string, sortOrder int) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.CreateCollectionLocale(ctx, id, language, name, cover, description, meta, sortOrder); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) UpdateCollectionLocale(ctx context.Context, id, language string, name, cover, description, meta *string, sortOrder *int) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.UpdateCollectionLocale(ctx, id, language, name, cover, description, meta, sortOrder); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) SetCollectionCover(ctx context.Context, id, cover string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetCollectionCover(ctx, id, cover); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) GetCollection(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return catalog.Collection{}, nil, false, err
	}
	defer release()
	return r.GetCollection(ctx, id)
}

func (s *Store) ListCollections(ctx context.Context, opts catalog.CollectionListOpts) ([]catalog.Collection, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListCollections(ctx, opts)
}

func (s *Store) DeleteCollection(ctx context.Context, id string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteCollection(ctx, id); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) DeleteCollectionLocale(ctx context.Context, id, language string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteCollectionLocale(ctx, id, language); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) SetCollectionTracks(ctx context.Context, collectionID, language string, trackIDs []string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetCollectionTracks(ctx, collectionID, language, trackIDs); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) AddCollectionTrack(ctx context.Context, collectionID, language, trackID string, position *int) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.AddCollectionTrack(ctx, collectionID, language, trackID, position); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) RemoveCollectionTrack(ctx context.Context, collectionID, language, trackID string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.RemoveCollectionTrack(ctx, collectionID, language, trackID); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) SetCollectionTags(ctx context.Context, collectionID, language string, tagIDs []string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetCollectionTags(ctx, collectionID, language, tagIDs); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) AddCollectionTag(ctx context.Context, collectionID, language, tagID string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.AddCollectionTag(ctx, collectionID, language, tagID); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) RemoveCollectionTag(ctx context.Context, collectionID, language, tagID string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.RemoveCollectionTag(ctx, collectionID, language, tagID); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) TrackLanguages(ctx context.Context, trackID string) ([]string, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.TrackLanguages(ctx, trackID)
}
