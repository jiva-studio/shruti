-- Restoring NOT NULL is only safe when no rows have NULL. Coalesce
-- existing NULLs to false first (matches the original column default).
UPDATE auth.identities SET email_verified = FALSE WHERE email_verified IS NULL;
ALTER TABLE auth.identities ALTER COLUMN email_verified SET NOT NULL;
