-- The page-level "nothing changed" shortcut was skipping the per-file check
-- that notices a new prompt, so editing a prompt quietly changed nothing until
-- someone forced a re-run.
--
-- Recording which prompt a page's files were last read with lets the shortcut
-- stand down when that answer is stale, which is what makes "bump the prompt
-- and everything re-normalizes" true without anyone clearing a table.

ALTER TABLE discovery.pages ADD COLUMN IF NOT EXISTS norm_prompt_version text;
