package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

// --- collection-group methods on Lazy (open-on-demand wrapper) ---

func (l *Lazy) CreateCollectionGroupLocale(ctx context.Context, id, language, name, description, meta string, sortOrder int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.CreateCollectionGroupLocale(ctx, id, language, name, description, meta, sortOrder); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) UpdateCollectionGroupLocale(ctx context.Context, id, language string, name, description, meta *string, sortOrder *int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.UpdateCollectionGroupLocale(ctx, id, language, name, description, meta, sortOrder); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) GetCollectionGroup(ctx context.Context, id string) (catalog.CollectionGroup, map[string][]string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return catalog.CollectionGroup{}, nil, false, err
	}
	defer r.Close()
	return r.GetCollectionGroup(ctx, id)
}

func (l *Lazy) ListCollectionGroups(ctx context.Context, opts catalog.CollectionGroupListOpts) ([]catalog.CollectionGroup, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListCollectionGroups(ctx, opts)
}

func (l *Lazy) DeleteCollectionGroup(ctx context.Context, id string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteCollectionGroup(ctx, id); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) DeleteCollectionGroupLocale(ctx context.Context, id, language string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteCollectionGroupLocale(ctx, id, language); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) SetCollectionGroupCollections(ctx context.Context, groupID, language string, collectionIDs []string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetCollectionGroupCollections(ctx, groupID, language, collectionIDs); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) AddCollectionGroupCollection(ctx context.Context, groupID, language, collectionID string, position *int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.AddCollectionGroupCollection(ctx, groupID, language, collectionID, position); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) RemoveCollectionGroupCollection(ctx context.Context, groupID, language, collectionID string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.RemoveCollectionGroupCollection(ctx, groupID, language, collectionID); err != nil {
		return err
	}
	return markModified(l.Path)
}
