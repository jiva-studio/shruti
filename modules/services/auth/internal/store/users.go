package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
	ID         uuid.UUID
	Name       *string
	PictureURL *string
	CreatedAt  time.Time
}

type UserRepo struct{ Pool *pgxpool.Pool }

func (r *UserRepo) Create(ctx context.Context, tx pgx.Tx) (uuid.UUID, error) {
	var id uuid.UUID
	q := `INSERT INTO auth.users DEFAULT VALUES RETURNING id`
	if err := selectRow(ctx, r.Pool, tx, q).Scan(&id); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (r *UserRepo) Get(ctx context.Context, id uuid.UUID) (*User, error) {
	row := r.Pool.QueryRow(ctx,
		`SELECT id, name, picture_url, created_at FROM auth.users WHERE id = $1`, id)
	u := &User{}
	if err := row.Scan(&u.ID, &u.Name, &u.PictureURL, &u.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return u, nil
}

// SetNameIfEmpty writes name only when the existing column is NULL.
// Apple's fullName is one-time on first signin; we don't overwrite later.
func (r *UserRepo) SetNameIfEmpty(ctx context.Context, tx pgx.Tx, id uuid.UUID, name string) error {
	_, err := exec(ctx, r.Pool, tx,
		`UPDATE auth.users SET name = $2 WHERE id = $1 AND name IS NULL`,
		id, name,
	)
	return err
}

// SetPictureURL overwrites the URL on every call — Google rotates avatar
// URLs, so the last sign-in's value wins. Callers skip the call when the
// provider didn't return a picture (Apple).
func (r *UserRepo) SetPictureURL(ctx context.Context, tx pgx.Tx, id uuid.UUID, url string) error {
	_, err := exec(ctx, r.Pool, tx,
		`UPDATE auth.users SET picture_url = $2 WHERE id = $1`,
		id, url,
	)
	return err
}

// Delete cascades to identities and refresh_tokens via FK ON DELETE CASCADE.
func (r *UserRepo) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.Pool.Exec(ctx, `DELETE FROM auth.users WHERE id = $1`, id)
	return err
}
