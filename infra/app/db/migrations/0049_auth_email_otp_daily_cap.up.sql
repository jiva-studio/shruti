-- Email OTP attempt accounting per address, independent of resends.
--
-- attempts                   verify attempts since attempts_window_started_at
--                            (rolling 24h window, never reset by a resend)
-- attempts_window_started_at start of that window; NULL = no window open
-- code_attempts              verify attempts against the current code, reset
--                            by a resend; NULL on rows written before this
--                            migration, where `attempts` still holds it
ALTER TABLE auth.email_otps
    ADD COLUMN attempts_window_started_at timestamptz,
    ADD COLUMN code_attempts integer;
