// Package pull pages a user's change log to a device.
package pull

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// Request asks for changes after Cursor, up to Limit.
type Request struct {
	Cursor int64
	Limit  int
}

// Result is one page: its changes in global_seq order, the cursor to ask from
// next, and whether another page remains. Changes is non-nil.
type Result struct {
	Changes []changes.Change
	Cursor  int64
	HasMore bool
}

// UseCase serves pulls.
type UseCase struct {
	feed     ports.ChangeFeed
	maxLimit int
}

// New builds the pull use case. maxLimit is the largest page a client may ask
// for; a larger or non-positive limit is clamped to it.
func New(feed ports.ChangeFeed, maxLimit int) (*UseCase, error) {
	if feed == nil {
		return nil, errors.New("pull: nil change feed")
	}
	if maxLimit <= 0 {
		return nil, errors.New("pull: max limit must be positive")
	}
	return &UseCase{feed: feed, maxLimit: maxLimit}, nil
}

// Pull returns the user's changes after the request cursor, including the
// caller's own writes: re-applying them is an idempotent no-op, and it is how
// a device that lost its local copy recovers its own data from cursor 0.
func (u *UseCase) Pull(ctx context.Context, userID uuid.UUID, req Request) (Result, error) {
	limit := req.Limit
	if limit <= 0 || limit > u.maxLimit {
		limit = u.maxLimit
	}
	page, err := u.feed.Since(ctx, userID, req.Cursor, limit)
	if err != nil {
		return Result{}, err
	}
	if page == nil {
		page = []changes.Change{}
	}
	cursor := req.Cursor
	if n := len(page); n > 0 {
		cursor = page[n-1].ServerSeq
	}
	return Result{Changes: page, Cursor: cursor, HasMore: len(page) == limit}, nil
}
