package sqlitecatalog

import (
	"context"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

// --- collection methods on Lazy (open-on-demand wrapper) ---

func (l *Lazy) CreateCollectionLocale(ctx context.Context, id, language, name string, featured bool, sortOrder int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.CreateCollectionLocale(ctx, id, language, name, featured, sortOrder); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) UpdateCollectionLocale(ctx context.Context, id, language string, name *string, featured *bool, sortOrder *int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.UpdateCollectionLocale(ctx, id, language, name, featured, sortOrder); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) GetCollection(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error) {
	r, err := l.open(ctx)
	if err != nil {
		return catalog.Collection{}, nil, false, err
	}
	defer r.Close()
	return r.GetCollection(ctx, id)
}

func (l *Lazy) ListCollections(ctx context.Context, opts catalog.CollectionListOpts) ([]catalog.Collection, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.ListCollections(ctx, opts)
}

func (l *Lazy) DeleteCollection(ctx context.Context, id string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteCollection(ctx, id); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) DeleteCollectionLocale(ctx context.Context, id, language string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.DeleteCollectionLocale(ctx, id, language); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) SetCollectionTracks(ctx context.Context, collectionID, language string, trackIDs []string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetCollectionTracks(ctx, collectionID, language, trackIDs); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) AddCollectionTrack(ctx context.Context, collectionID, language, trackID string, position *int) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.AddCollectionTrack(ctx, collectionID, language, trackID, position); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) RemoveCollectionTrack(ctx context.Context, collectionID, language, trackID string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.RemoveCollectionTrack(ctx, collectionID, language, trackID); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) TrackLanguages(ctx context.Context, trackID string) ([]string, error) {
	r, err := l.open(ctx)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.TrackLanguages(ctx, trackID)
}
