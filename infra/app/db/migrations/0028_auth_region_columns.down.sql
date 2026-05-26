DROP INDEX IF EXISTS auth.identities_provider_subject_idx;
ALTER TABLE auth.identities DROP COLUMN IF EXISTS home_region;
ALTER TABLE auth.users      DROP COLUMN IF EXISTS home_region;
