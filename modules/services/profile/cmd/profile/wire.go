package main

import (
	"github.com/jiva-studio/shruti/profile/internal/application/cursor"
	"github.com/jiva-studio/shruti/profile/internal/application/library"
	"github.com/jiva-studio/shruti/profile/internal/application/pull"
	"github.com/jiva-studio/shruti/profile/internal/application/purge"
	"github.com/jiva-studio/shruti/profile/internal/application/push"
	"github.com/jiva-studio/shruti/profile/internal/infra/postgres"
)

// useCases is every scenario `profile serve` runs, bound to one store.
type useCases struct {
	push    *push.UseCase
	pull    *pull.UseCase
	cursor  *cursor.UseCase
	purge   *purge.UseCase
	library *library.UseCase
}

func newUseCases(st *postgres.Store, pullMaxLimit int) (useCases, error) {
	var (
		u   useCases
		err error
	)
	if u.push, err = push.New(st); err != nil {
		return useCases{}, err
	}
	if u.pull, err = pull.New(st, pullMaxLimit); err != nil {
		return useCases{}, err
	}
	if u.cursor, err = cursor.New(st); err != nil {
		return useCases{}, err
	}
	if u.purge, err = purge.New(st); err != nil {
		return useCases{}, err
	}
	if u.library, err = library.New(st); err != nil {
		return useCases{}, err
	}
	return u, nil
}
