-- Per-job re-run counter. Incremented when a dead-lettered (failed) job is
-- restarted by a user-initiated retry, so the re-run's track.events lifecycle
-- stamps sort above the prior run's terminal state (see profile hlc.Ranked).
-- 0 for the original run — every existing row backfills to 0.
ALTER TABLE orchestrator.jobs
    ADD COLUMN generation int NOT NULL DEFAULT 0;
