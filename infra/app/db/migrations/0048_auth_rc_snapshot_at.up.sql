-- Time of the RevenueCat subscriber snapshot the tier columns were last
-- written from (RC's request_date_ms, or the local time the fetch started).
-- A snapshot older than this value is not applied, so a slow webhook, the
-- reconcile cron or a grant cannot overwrite a newer state with an older
-- one. NULL until the first snapshot is applied.
ALTER TABLE auth.users ADD COLUMN rc_snapshot_at TIMESTAMPTZ;
