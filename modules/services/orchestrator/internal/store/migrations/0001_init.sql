-- orchestrator schema — the generic job store + a transactional outbox.
--
-- `jobs` is the SOURCE OF TRUTH for every orchestrated task (the first being
-- personal-library ingest). Lifecycle events published to the broker are a
-- projection of a job's state written into `outbox` in the same transaction,
-- so a crash never drops an event — a relay drains outbox -> stream.

CREATE SCHEMA IF NOT EXISTS orchestrator;

-- One row per orchestrated task. `kind` keeps the aggregate generic; `spec`
-- holds the kind-specific request, `result` the terminal payload.
CREATE TABLE orchestrator.jobs (
    id         uuid        PRIMARY KEY,
    kind       text        NOT NULL,                       -- e.g. 'library_ingest'
    owner_id   uuid,                                       -- requesting user (null for system jobs)
    state      text        NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued','running','done','failed','cancelled')),
    spec       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    progress   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    result     jsonb,
    track_id   text,                                       -- content hash, set after fetch
    error      text,
    attempts   int         NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_state_idx ON orchestrator.jobs (state, updated_at);
CREATE INDEX jobs_owner_idx ON orchestrator.jobs (owner_id, created_at DESC);

-- Transactional outbox: producers append here in the same tx as the job write;
-- a relay reads unpublished rows in order and XADDs them to the broker, then
-- stamps published_at. Delivery is at-least-once; consumers are idempotent.
CREATE TABLE orchestrator.outbox (
    seq          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    topic        text        NOT NULL,                     -- stream name, e.g. 'track.events'
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON orchestrator.outbox (seq) WHERE published_at IS NULL;
