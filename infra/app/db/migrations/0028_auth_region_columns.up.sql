-- Wave 2 / PR-1: home_region columns on auth.users and auth.identities
-- plus a (provider, subject) lookup index for the /auth/lookup probe.
--
-- home_region pins a user (and each of their identities) to one regional
-- deployment. Default 'global' keeps every existing row backwards-
-- compatible: today's single Cloud Provider deploy IS the global region, so the
-- column is a free addition.
--
-- When the Russia VPS comes online (Wave 7) new users land with
-- home_region='russia' driven by the local config and PROFILE=ru.
-- Migrate-in/-revoke flows (PR-2a) flip the column atomically as a user
-- moves between regions.
--
-- The (provider, subject) btree powers POST /auth/lookup — a no-side-
-- effect existence probe used by the mobile signin retry-other-region
-- flow (PR-3). The existing primary key on auth.identities already
-- enforces uniqueness on this pair, but the PK ordering puts provider
-- last for that schema, so a dedicated index keeps the lookup an index
-- scan on small RU/global deploys.

ALTER TABLE auth.users      ADD COLUMN home_region TEXT NOT NULL DEFAULT 'global';
ALTER TABLE auth.identities ADD COLUMN home_region TEXT NOT NULL DEFAULT 'global';
CREATE INDEX identities_provider_subject_idx ON auth.identities(provider, subject);
