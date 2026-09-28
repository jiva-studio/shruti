package sqlitecatalog

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

func (s *Store) Scheme(ctx context.Context) (int, error) {
	r, release, err := s.acquire()
	if err != nil {
		return 0, err
	}
	defer release()
	return r.Scheme(ctx)
}

func (s *Store) GetDict(ctx context.Context, kind catalog.Kind, id string) (catalog.DictEntry, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return catalog.DictEntry{}, false, err
	}
	defer release()
	return r.GetDict(ctx, kind, id)
}

func (s *Store) ListDict(ctx context.Context, kind catalog.Kind, opts catalog.ListOpts) ([]catalog.DictEntry, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListDict(ctx, kind, opts)
}

func (s *Store) ListTopicCovers(ctx context.Context) ([]catalog.TopicCover, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.ListTopicCovers(ctx)
}

func (s *Store) UsageCount(ctx context.Context, kind catalog.Kind, id string) (int, error) {
	r, release, err := s.acquire()
	if err != nil {
		return 0, err
	}
	defer release()
	return r.UsageCount(ctx, kind, id)
}

func (s *Store) LookupIDByName(ctx context.Context, kind catalog.Kind, name, language string) (string, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return "", false, err
	}
	defer release()
	return r.LookupIDByName(ctx, kind, name, language)
}

func (s *Store) GetTrack(ctx context.Context, id string) (catalog.TrackRow, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return catalog.TrackRow{}, false, err
	}
	defer release()
	return r.GetTrack(ctx, id)
}

func (s *Store) GetVariant(ctx context.Context, trackID, language string) (catalog.VariantRow, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return catalog.VariantRow{}, false, err
	}
	defer release()
	return r.GetVariant(ctx, trackID, language)
}

func (s *Store) GetAudios(ctx context.Context, trackID, language string) ([]catalog.AudioRow, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.GetAudios(ctx, trackID, language)
}

func (s *Store) UpsertAudio(ctx context.Context, a catalog.AudioRow) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.UpsertAudio(ctx, a); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) UpsertAudios(ctx context.Context, rows []catalog.AudioRow) error {
	if len(rows) == 0 {
		return nil
	}
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.UpsertAudios(ctx, rows); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) GetReferences(ctx context.Context, trackID string) ([]catalog.TrackReference, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.GetReferences(ctx, trackID)
}

func (s *Store) GetTrackTags(ctx context.Context, trackID string) ([]string, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.GetTrackTags(ctx, trackID)
}

// --- mutating dict methods (delegated to underlying Repo) ---

func (s *Store) CreateDict(ctx context.Context, kind catalog.Kind, e catalog.DictEntry) (string, error) {
	r, release, err := s.acquire()
	if err != nil {
		return "", err
	}
	defer release()
	id, err := r.CreateDict(ctx, kind, e)
	if err != nil {
		return "", err
	}
	return id, markModified(s.path)
}
func (s *Store) UpdateDictLocale(ctx context.Context, kind catalog.Kind, id, language, fullName, shortName string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.UpdateDictLocale(ctx, kind, id, language, fullName, shortName); err != nil {
		return err
	}
	return markModified(s.path)
}
func (s *Store) DeleteDictLocale(ctx context.Context, kind catalog.Kind, id, language string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteDictLocale(ctx, kind, id, language); err != nil {
		return err
	}
	return markModified(s.path)
}
func (s *Store) DeleteDict(ctx context.Context, kind catalog.Kind, id string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteDict(ctx, kind, id); err != nil {
		return err
	}
	return markModified(s.path)
}
func (s *Store) SaveTrack(ctx context.Context, t catalog.TrackRow, v catalog.VariantRow, audios []catalog.AudioRow, refs []catalog.TrackReference) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SaveTrack(ctx, t, v, audios, refs); err != nil {
		return err
	}
	return markModified(s.path)
}
func (s *Store) SetVariantOutline(ctx context.Context, trackID, language, outline, description string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetVariantOutline(ctx, trackID, language, outline, description); err != nil {
		return err
	}
	return markModified(s.path)
}
func (s *Store) SetTrackTopics(ctx context.Context, trackID string, weights map[string]float64) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetTrackTopics(ctx, trackID, weights); err != nil {
		return err
	}
	return markModified(s.path)
}
func (s *Store) SetTopicCover(ctx context.Context, id, cover string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetTopicCover(ctx, id, cover); err != nil {
		return err
	}
	return markModified(s.path)
}
func (s *Store) GetTopicName(ctx context.Context, id, language string) (string, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return "", false, err
	}
	defer release()
	return r.GetTopicName(ctx, id, language)
}
func (s *Store) DeleteTrackVariant(ctx context.Context, trackID, language string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.DeleteTrackVariant(ctx, trackID, language); err != nil {
		return err
	}
	return markModified(s.path)
}

var _ catalogport.Repository = (*Store)(nil)
