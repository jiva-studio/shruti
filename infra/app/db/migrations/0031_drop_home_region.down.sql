-- Reverse of 0031: re-add the home_region columns + lookup index.
-- Re-stamps every existing row with the legacy default 'global' so
-- a rollback never produces NULL on a NOT NULL column.

SET lock_timeout = '30s';

ALTER TABLE auth.users      ADD COLUMN home_region TEXT NOT NULL DEFAULT 'global';
ALTER TABLE auth.identities ADD COLUMN home_region TEXT NOT NULL DEFAULT 'global';
CREATE INDEX IF NOT EXISTS identities_provider_subject_idx
    ON auth.identities(provider, subject);
