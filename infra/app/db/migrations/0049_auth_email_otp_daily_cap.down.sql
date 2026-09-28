ALTER TABLE auth.email_otps
    DROP COLUMN IF EXISTS code_attempts,
    DROP COLUMN IF EXISTS attempts_window_started_at;
