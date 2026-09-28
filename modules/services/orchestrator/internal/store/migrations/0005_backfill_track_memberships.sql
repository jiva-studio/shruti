-- Backfill the projection 0004 introduced for tracks ingested before it.
--
-- Such a track has an ingest job but no track_memberships row and a NULL
-- jobs.membership_id, so a translate of it has nothing to merge into.
--
-- The ingest run id is the membership id (runIdentity), the terminal jobs.result
-- is the doc a ready would have written, and jobs.generation is the version
-- mergeReady stamps — so these rows reconstruct exactly.
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
