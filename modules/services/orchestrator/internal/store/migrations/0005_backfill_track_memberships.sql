-- Backfill the projection 0004 introduced but never populated.
--
-- The personal library shipped 2026-07-29; 0004 landed 2026-08-01. Every track
-- added in between has an ingest job but NO track_memberships row and a NULL
-- jobs.membership_id, so a later translate of that track found nothing to merge
-- into and failed on every redelivery (issue #1621).
--
-- The ingest run id IS the membership id (runIdentity), the terminal jobs.result
-- IS the doc a ready would have written, and jobs.generation IS the version
-- mergeReady stamps — so the historical rows reconstruct exactly.
--
-- Idempotent: the insert conflicts away and the update is guarded on NULL, so a
-- re-run is a no-op.

INSERT INTO orchestrator.track_memberships (membership_id, owner_id, version, doc, updated_at)
SELECT j.id::text, j.owner_id, j.generation, COALESCE(j.result, '{}'::jsonb), j.updated_at
  FROM orchestrator.jobs j
 WHERE j.op = 'ingest'
   AND j.state = 'done'
   AND j.owner_id IS NOT NULL
ON CONFLICT (membership_id) DO NOTHING;

UPDATE orchestrator.jobs
   SET membership_id = id::text
 WHERE op = 'ingest'
   AND membership_id IS NULL;
