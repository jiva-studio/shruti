-- Drop the auth.users.home_region and auth.identities.home_region
-- columns introduced by 0028.
--
-- Single-region collapse (#728): the multi-region architecture is
-- abandoned. RU becomes a thin reverse proxy in front of a single
-- global backend, and every auth row belongs implicitly to that
-- one deployment. Nothing in code reads `home_region` after this
-- migration lands (auth service: store/profile/service callers all
-- drop the field in the same PR; mobile: WS-3 strips it from the
-- /auth/me consumer).
--
-- Also drops the (provider, subject) index from 0028 that backed
-- /auth/lookup — the endpoint is gone in this PR, the primary key
-- on auth.identities already covers the remaining lookup paths.
--
-- Lock safety: each ALTER TABLE acquires AccessExclusiveLock on the
-- target. auth.users and auth.identities are small (low tens-of-k
-- rows in prod), so the windows are sub-second; fail fast on lock
-- contention instead of stalling boot behind a long-running query
-- (mirrors the pattern from the #701 fix in 0030).

SET lock_timeout = '30s';

ALTER TABLE auth.users      DROP COLUMN IF EXISTS home_region;
ALTER TABLE auth.identities DROP COLUMN IF EXISTS home_region;
DROP INDEX IF EXISTS auth.identities_provider_subject_idx;
