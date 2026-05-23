-- Auth service initial schema.
-- Isolated under `auth.*` schema; no cross-references to chat or other public objects.

CREATE SCHEMA IF NOT EXISTS auth;

-- Account-level row. A user can have many identities (one per provider).
CREATE TABLE auth.users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Display name. Populated one-time from Apple's fullName on first signin;
    -- left untouched on subsequent signins.
    name        text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per (provider, subject). Subject = Google sub / Apple sub / device id.
-- email is per-provider; email_verified controls whether we use it for cross-link.
CREATE TABLE auth.identities (
    provider        text NOT NULL,           -- 'google' | 'apple' | 'device'
    subject         text NOT NULL,           -- provider's stable user id
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email           text,
    email_verified  boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user_id_idx ON auth.identities(user_id);
-- Cross-link lookup: only verified emails count.
CREATE INDEX identities_email_verified_idx
    ON auth.identities(email)
    WHERE email_verified;

-- One row per issued refresh token. Single-use; rotation marks revoked_at.
CREATE TABLE auth.refresh_tokens (
    jti         uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id   text,                        -- the device this session was issued to
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_id_idx ON auth.refresh_tokens(user_id);
CREATE INDEX refresh_tokens_cleanup_idx
    ON auth.refresh_tokens(expires_at)
    WHERE revoked_at IS NULL;
