-- Some archives put their media behind an account: the page is public, the
-- file is not, and the address of the file only appears once you are signed in.
--
-- Credentials are a property of the source, not of the engine, and every scheme
-- worth supporting arrives as a header — a session cookie, a bearer token, an
-- API key. So one map of headers covers all of them and nothing here knows
-- which scheme any site uses.

ALTER TABLE discovery.sources
    ADD COLUMN IF NOT EXISTS auth_headers jsonb NOT NULL DEFAULT '{}'::jsonb;
