package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti-share-video/internal/types"
)

// TaskKind is the constant used in public.tasks.kind to bucket
// share-video render jobs separately from chat's own use of the table.
const TaskKind = "share_video.render"

// TaskRow is what the worker reads off the queue. Stripped to the
// fields the worker actually uses; full table has more columns.
type TaskRow struct {
	ID          string
	Payload     types.TaskPayload
	Attempts    int
	MaxAttempts int
}

// TaskState mirrors what HTTP layer reads when polling. Status is left
// as a string so that any extra states a future migration adds don't
// need a code change to surface.
type TaskState struct {
	ID     string
	Status string
	Result *types.TaskResult
	Error  string
}

// ErrTaskNotFound is returned by FindOwnTask when no row matches the
// owner-filtered SELECT.
var ErrTaskNotFound = errors.New("task not found")

// ErrLeaseLost is returned by Finish / Fail when the row is no longer
// owned by the caller (status flipped to 'pending' by ReviveExpired,
// or worker_id changed because another worker picked the task up
// after the lease expired). The caller must NOT retry the transition
// — another worker is the source of truth now.
var ErrLeaseLost = errors.New("lease lost")

// Insert creates a pending row. max_attempts is omitted on purpose so
// the column default from the migration takes effect.
func Insert(ctx context.Context, pool *pgxpool.Pool, id string, payload types.TaskPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO tasks (id, kind, payload, status)
		 VALUES ($1, $2, $3::jsonb, 'pending')`,
		id, TaskKind, string(body),
	)
	return err
}

// FindOwnTask returns the task with the given id only if the caller
// owns it (payload.user_id == userID). 404-on-mismatch semantics live
// in the caller — this is the leak-proof read.
func FindOwnTask(ctx context.Context, pool *pgxpool.Pool, id, userID string) (TaskState, error) {
	var (
		status     string
		resultJSON []byte
		errMsg     *string
	)
	err := pool.QueryRow(ctx,
		`SELECT status, result, error
		   FROM tasks
		  WHERE id = $1 AND kind = $2 AND payload->>'user_id' = $3`,
		id, TaskKind, userID,
	).Scan(&status, &resultJSON, &errMsg)
	if errors.Is(err, pgx.ErrNoRows) {
		return TaskState{}, ErrTaskNotFound
	}
	if err != nil {
		return TaskState{}, err
	}
	st := TaskState{ID: id, Status: status}
	if len(resultJSON) > 0 && string(resultJSON) != "null" {
		var r types.TaskResult
		if jerr := json.Unmarshal(resultJSON, &r); jerr == nil {
			st.Result = &r
		}
	}
	if errMsg != nil {
		st.Error = *errMsg
	}
	return st, nil
}

// LeaseOne picks the oldest pending task of TaskKind, transitions it to
// running, and stamps lease_expires_at. Single UPDATE … FROM picked …
// RETURNING keeps the SKIP-LOCKED guarantee without an explicit
// transaction. Returns nil row when nothing is pending.
func LeaseOne(ctx context.Context, pool *pgxpool.Pool, workerID string, leaseMs int64) (*TaskRow, error) {
	const sql = `
		WITH picked AS (
		  SELECT id FROM tasks
		   WHERE kind = $1 AND status = 'pending'
		   ORDER BY created_at
		   FOR UPDATE SKIP LOCKED
		   LIMIT 1
		)
		UPDATE tasks t SET
		  status            = 'running',
		  attempts          = attempts + 1,
		  started_at        = now(),
		  lease_expires_at  = now() + ($2 || ' milliseconds')::interval,
		  worker_id         = $3
		FROM picked
		WHERE t.id = picked.id
		RETURNING t.id, t.payload, t.attempts, t.max_attempts
	`
	var (
		id           string
		payloadJSON  []byte
		attempts     int
		maxAttempts  int
	)
	err := pool.QueryRow(ctx, sql, TaskKind, strconv.FormatInt(leaseMs, 10), workerID).
		Scan(&id, &payloadJSON, &attempts, &maxAttempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p types.TaskPayload
	if err := json.Unmarshal(payloadJSON, &p); err != nil {
		return nil, fmt.Errorf("decode payload for task %s: %w", id, err)
	}
	return &TaskRow{ID: id, Payload: p, Attempts: attempts, MaxAttempts: maxAttempts}, nil
}

// Finish transitions a running task to done, persisting the result URL
// and S3 key in the `result` jsonb column.
//
// The WHERE clause asserts (status='running' AND worker_id=$4) so a
// task that's been revived back to 'pending' (lease expired and
// ReviveExpired flipped it) does NOT get clobbered to 'done' here —
// the new lease holder is the source of truth. RowsAffected() == 0
// translates to ErrLeaseLost.
func Finish(ctx context.Context, pool *pgxpool.Pool, id, workerID string, r types.TaskResult) error {
	tag, err := pool.Exec(ctx,
		`UPDATE tasks
		    SET status='done',
		        result=jsonb_build_object('url', $2::text, 'output_key', $3::text),
		        finished_at=now(),
		        lease_expires_at=NULL
		  WHERE id=$1 AND status='running' AND worker_id=$4`,
		id, r.URL, r.OutputKey, workerID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// Fail pushes the task back to pending (if retries remain) or to failed
// terminally. Returns whether a retry was queued (informational).
//
// Same lease-guard as Finish: only acts if (status='running' AND
// worker_id=$4). If the lease was revived under the worker's feet
// (ReviveExpired flipped status to 'pending' and cleared worker_id),
// the caller has lost ownership and gets ErrLeaseLost — the next
// worker to lease the task owns its outcome.
func Fail(ctx context.Context, pool *pgxpool.Pool, id, workerID string, attempts, maxAttempts int, errorMessage string) (willRetry bool, err error) {
	willRetry = attempts < maxAttempts
	newStatus := "failed"
	if willRetry {
		newStatus = "pending"
	}
	tag, err := pool.Exec(ctx,
		`UPDATE tasks
		    SET status            = $2,
		        error             = $3,
		        finished_at       = CASE WHEN $2='failed' THEN now() ELSE finished_at END,
		        lease_expires_at  = NULL,
		        worker_id         = CASE WHEN $2='pending' THEN NULL ELSE worker_id END
		  WHERE id=$1 AND status='running' AND worker_id=$4`,
		id, newStatus, errorMessage, workerID,
	)
	if err != nil {
		return willRetry, err
	}
	if tag.RowsAffected() == 0 {
		return willRetry, ErrLeaseLost
	}
	return willRetry, nil
}

// ReviveExpired flips any 'running' rows whose lease has expired back
// to 'pending' so the next LeaseOne picks them up. Kind-agnostic on
// purpose: covers anything that crashed mid-run, not just our kind.
func ReviveExpired(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx,
		`UPDATE tasks
		    SET status='pending', worker_id=NULL, lease_expires_at=NULL
		  WHERE status='running' AND lease_expires_at < now()`,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
