-- Generic async-job queue. Multiple producers/workers across services share
-- one table, discriminated by `kind`. share-video is first user
-- (kind='share_video.render'); future async work (chat batch reindex, auth
-- batch cleanups, …) plugs in with new `kind` values without schema changes.
--
-- Worker contract:
--   1. SELECT … WHERE kind=$1 AND status='pending'
--      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
--   2. UPDATE … SET status='running', started_at=now(),
--      lease_expires_at=now()+interval '10 min', worker_id=$2 WHERE id=$task
--   3. do the work …
--   4. UPDATE … SET status='done', result=…, finished_at=now() WHERE id=$task
--      (or status='failed' / status='pending' for retry depending on attempts)
--
-- Crash recovery on worker boot (kind-agnostic):
--   UPDATE tasks SET status='pending'
--    WHERE status='running' AND lease_expires_at < now();

CREATE TABLE tasks (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind               text        NOT NULL,
    payload            jsonb       NOT NULL,
    status             text        NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
    attempts           int         NOT NULL DEFAULT 0,
    max_attempts       int         NOT NULL DEFAULT 3,
    result             jsonb,
    error              text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    started_at         timestamptz,
    finished_at        timestamptz,
    lease_expires_at   timestamptz,
    worker_id          text,
    CHECK (status IN ('pending', 'running', 'done', 'failed'))
);

-- FIFO worker poll: pick oldest pending of a kind.
CREATE INDEX tasks_kind_status_created ON tasks (kind, status, created_at);

-- Recovery scan: cheap probe of expired-lease running rows.
CREATE INDEX tasks_running_lease ON tasks (status, lease_expires_at)
    WHERE status = 'running';
