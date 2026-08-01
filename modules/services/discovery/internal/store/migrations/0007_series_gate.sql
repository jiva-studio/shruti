-- Asking a model "is this a cycle?" about every page that carried no audio was
-- backwards: on any site most pages carry no audio, so the question was being
-- put to menus, sections, sign-in pages and the account pages of whoever we are
-- signed in as. Sixteen calls on the first twenty-five pages of one archive, to
-- be told each time that a menu is a menu.
--
-- A cycle is made of recordings, so a page none of whose links reach a
-- recording we have cannot be one. Remembering how many of its links did reach
-- one at the time we asked keeps the question from being re-asked every visit,
-- and lets it be asked again once more parts turn up.

ALTER TABLE discovery.pages
    ADD COLUMN IF NOT EXISTS series_links_seen integer NOT NULL DEFAULT 0;
