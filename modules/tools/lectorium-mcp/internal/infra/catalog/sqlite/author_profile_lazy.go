package sqlitecatalog

import "context"

// --- author profile methods on Lazy (open-on-demand wrapper) ---

func (l *Lazy) SetAuthorImage(ctx context.Context, id, key string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetAuthorImage(ctx, id, key); err != nil {
		return err
	}
	return markModified(l.Path)
}

func (l *Lazy) SetAuthorDescription(ctx context.Context, id, language, description string) error {
	r, err := l.open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.SetAuthorDescription(ctx, id, language, description); err != nil {
		return err
	}
	return markModified(l.Path)
}
