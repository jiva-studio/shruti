// Package ports declares the orchestrator's driven interfaces — the extension
// surface. The orchestrator is a thin COORDINATOR, so its ports are the job
// store, the transactional-outbox event bus, and the PRO-tier verifier. The
// heavy fetch/transcribe/store adapters live in the separate `ingest` worker
// (which owns its own ports); the orchestrator dispatches work to it via an
// `ingest.work` outbox row and reacts to `ingest.result`.
package ports

import (
	"context"

	"github.com/jiva-studio/shruti/orchestrator/internal/domain/job"
)

// EventBus publishes messages to the broker via the transactional outbox (the
// payload is enqueued in the same tx as the job write). The orchestrator uses
// it for BOTH the `track.events` lifecycle and the `ingest.work` dispatch —
// the outbox row's topic selects the destination stream.
type EventBus interface {
	Publish(ctx context.Context, q Tx, topic string, payload []byte) error
}

// JobRepository persists the Job aggregate — the source of truth.
//
// The plain Create/Get/Save run against the pool; the CreateTx/SaveTx variants
// run within a caller-supplied Tx so a job write and its outbox rows (via
// EventBus.Publish) commit atomically — the transactional-outbox invariant.
type JobRepository interface {
	Create(ctx context.Context, j *job.Job) error
	Get(ctx context.Context, id string) (*job.Job, error)
	Save(ctx context.Context, j *job.Job) error
	CreateTx(ctx context.Context, q Tx, j *job.Job) error
	SaveTx(ctx context.Context, q Tx, j *job.Job) error
	// WithTx runs fn inside a transaction so a job write and its outbox rows
	// commit atomically.
	WithTx(ctx context.Context, fn func(Tx) error) error
}

// TierVerifier re-verifies the PRO entitlement carried in an ingest request's
// JWT at processing time (the tier could have lapsed since the request was
// enqueued). It returns the token subject (user id) and whether the token
// grants an ACTIVE pro tier; err is non-nil only for a malformed/invalid token.
type TierVerifier interface {
	VerifyPro(token string) (userID string, pro bool, err error)
}

// Tx is an opaque transaction handle threaded through repository + event bus so
// the outbox write shares the job write's transaction.
type Tx interface{}
