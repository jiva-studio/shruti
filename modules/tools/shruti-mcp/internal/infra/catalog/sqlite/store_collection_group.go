package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func (s *Store) CreateCollectionGroupLocale(ctx context.Context, id, language, name, description, meta string, sortOrder int) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.CreateCollectionGroupLocale(ctx, id, language, name, description, meta, sortOrder); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) UpdateCollectionGroupLocale(ctx context.Context, id, language string, name, description, meta *string, sortOrder *int) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.UpdateCollectionGroupLocale(ctx, id, language, name, description, meta, sortOrder); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) GetCollectionGroup(ctx context.Context, id string) (catalog.CollectionGroup, map[string][]string, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return catalog.CollectionGroup{}, nil, false, err
	}
	defer release()
	return r.GetCollectionGroup(ctx, id)
}

func (s *Store) ListCollectionGroups(ctx context.Context, opts catalog.CollectionGroupListOpts) ([]catalog.CollectionGroup, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListCollectionGroups(ctx, opts)
}

func (s *Store) DeleteCollectionGroup(ctx context.Context, id string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteCollectionGroup(ctx, id); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) DeleteCollectionGroupLocale(ctx context.Context, id, language string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteCollectionGroupLocale(ctx, id, language); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) SetCollectionGroupCollections(ctx context.Context, groupID, language string, collectionIDs []string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetCollectionGroupCollections(ctx, groupID, language, collectionIDs); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) AddCollectionGroupCollection(ctx context.Context, groupID, language, collectionID string, position *int) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.AddCollectionGroupCollection(ctx, groupID, language, collectionID, position); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) RemoveCollectionGroupCollection(ctx context.Context, groupID, language, collectionID string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.RemoveCollectionGroupCollection(ctx, groupID, language, collectionID); err != nil {
		return err
	}
	return markModified(s.path)
}
