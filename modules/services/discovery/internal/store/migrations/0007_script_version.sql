-- A page carries the version of the source script it was read with, for the
-- same reason it carries the prompt version: both decide what gets stored, and
-- a page whose validators all match is skipped without being looked at.
--
-- Without it, editing a script would appear to do nothing: what a corrected
-- script would improve stays as the previous version left it, and the only way
-- to find out is to compare a stored row against what the script now produces.
ALTER TABLE discovery.pages ADD COLUMN IF NOT EXISTS script_version text;
