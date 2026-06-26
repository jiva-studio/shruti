-- Passwordless email sign-in: one active one-time code per email address.
-- Codes are stored hashed (sha256 of email+code); plaintext never persists.
-- Rows are short-lived (consumed on verify, expired by expires_at) so no
-- index beyond the primary key is needed.
CREATE TABLE auth.email_otps (
    email        text        PRIMARY KEY,
    code_hash    text        NOT NULL,
    expires_at   timestamptz NOT NULL,
    attempts     integer     NOT NULL DEFAULT 0,
    last_sent_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);
