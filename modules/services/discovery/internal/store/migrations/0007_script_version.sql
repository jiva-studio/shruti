-- A page carries the version of the source script it was read with, for the
-- same reason it carries the prompt version: both decide what gets stored, and
-- a page whose validators all match is skipped without being looked at.
--
-- Without this, editing a script appears to do nothing. It was doing nothing:
-- the transcripts a corrected script would have improved stayed as the old one
-- left them, and the only way to find out was to compare a stored row against
-- what the script now produces.
ALTER TABLE discovery.pages ADD COLUMN IF NOT EXISTS script_version text;
