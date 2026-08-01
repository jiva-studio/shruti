-- A run that was killed mid-flight — a deploy, a restart, a crash — kept
-- finished_at NULL for ever and read as "still going". Every deploy left
-- another one, and nothing distinguished them from a run that really is in
-- progress.
--
-- The finish time is not invented: we never learned when it stopped, only that
-- it did. A run that never finished stays unfinished, and says why.

ALTER TABLE discovery.runs
    ADD COLUMN IF NOT EXISTS interrupted boolean NOT NULL DEFAULT false;

-- Anything unfinished at the moment this migration runs was interrupted by
-- definition: the process applying it is the one that just started.
UPDATE discovery.runs SET interrupted = true WHERE finished_at IS NULL;
