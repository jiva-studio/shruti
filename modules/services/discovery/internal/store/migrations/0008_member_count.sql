-- member_count was a stored number and it drifted, exactly the way a stored
-- number does: a cycle reconstructed from what its parts called it was written
-- once with a count of zero and then had members added, and nothing went back
-- to correct it. Forty of forty-three cycles claimed to be empty while holding
-- up to six recordings.
--
-- It is a count of rows in a table we already have. Counting them when asked
-- cannot be wrong.

ALTER TABLE discovery.collections DROP COLUMN IF EXISTS member_count;
