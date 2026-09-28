package sqlitecatalog

import "context"

func (s *Store) SetAuthorImage(ctx context.Context, id, key string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetAuthorImage(ctx, id, key); err != nil {
		return err
	}
	return markModified(s.path)
}

func (s *Store) SetAuthorDescription(ctx context.Context, id, language, description string) error {
	r, release, err := s.acquire()
	if err != nil {
		return err
	}
	defer release()
	if err := r.SetAuthorDescription(ctx, id, language, description); err != nil {
		return err
	}
	return markModified(s.path)
}
