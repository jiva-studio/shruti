-- content_jobs — in-flight / historical dedup for the ingest pipeline.
--
-- The track id is the SHA-256 of the canonical audio bytes (ingest.ContentID),
-- so identical audio always hashes to the same key. The first job to fetch a
-- given content wins an exclusive claim via the primary key; a concurrent (or
-- later) job that fetches identical audio gets a unique-violation and collapses
-- onto the winner instead of re-transcribing. The row also records the winning
-- job so the loser can point its result at the already-produced track.

CREATE TABLE orchestrator.content_jobs (
    hash       text        PRIMARY KEY,          -- ingest.ContentID (sha256 hex) == track_id
    job_id     uuid        NOT NULL,             -- the job that claimed this content
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_jobs_job_idx ON orchestrator.content_jobs (job_id);
