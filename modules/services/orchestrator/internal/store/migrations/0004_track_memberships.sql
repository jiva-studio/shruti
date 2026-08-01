-- track_memberships — the authoritative per-track projection the orchestrator
-- accrues ACROSS operations (ingest, translate, …). One row per library
-- membership; every op reads-modifies-writes it under a row lock.
--
-- `version` is the per-membership LWW clock: each projection-changing event bumps
-- it, and it is emitted into track.events as the ordering key so a later op (e.g.
-- a translated variant added to an already-ready track) always out-ranks the
-- prior state. It supersedes the old per-job jobs.generation counter.
--
-- `doc` is the current library_items payload (incl. the accumulated variants), so
-- a new op can append its variant to the full list without reconstructing it.

CREATE TABLE orchestrator.track_memberships (
    membership_id text        PRIMARY KEY,
    owner_id      uuid        NOT NULL,
    version       int         NOT NULL DEFAULT 0,
    doc           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Jobs are now per-OPERATION runs; `op` selects the worker branch, `membership_id`
-- links the run to the track projection it advances. Existing rows are ingest runs.
ALTER TABLE orchestrator.jobs ADD COLUMN op            text NOT NULL DEFAULT 'ingest';
ALTER TABLE orchestrator.jobs ADD COLUMN membership_id text;

CREATE INDEX jobs_membership_idx ON orchestrator.jobs (membership_id);
