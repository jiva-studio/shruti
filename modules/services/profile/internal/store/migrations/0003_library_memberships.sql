-- library_memberships — the user's DECISIONS about a personal-library item.
--
-- Companion to library_items (0002), but the mirror image of its ownership:
-- library_items is 100% server-owned (the ingest pipeline authors the FACTS —
-- title, status, audio keys). library_memberships is 100% CLIENT-owned (the
-- device authors the user's INTENT — is the lecture in my library or removed),
-- pushed and merged exactly like playlist_items. It is NOT in store.ServerOwned,
-- so the client push path accepts it.
--
-- doc_id = the library_items membership id (the same uuid), so the two join
-- 1:1 per item. A row exists only once the user has acted on the item; ABSENT
-- means the default (active / in the library). archived_at set = removed from
-- the library (soft delete); NULL = active. The client re-adds by clearing it,
-- never by deleting the row, so absent and archived_at IS NULL both mean active.
--
-- PK (user_id, doc_id) matches every other state table.

CREATE TABLE profile.library_memberships (
    user_id     uuid        NOT NULL,
    doc_id      text        NOT NULL,   -- = library_items membership id (uuid)
    archived_at timestamptz,            -- NULL = active (in library); set = removed
    updated_at  timestamptz,            -- last client write, for observability
    PRIMARY KEY (user_id, doc_id)
);
