-- Reverts 0045. The private lane needs ONE fact about an upload — who is
-- speaking — and `chunks.author_id` already models exactly that: the column the
-- public lane filters by, stamped per chunk the same way `doc_date` and
-- `addr_label` already are. The speaker is resolved once, when the track is
-- indexed, so the filter is a join instead of a side table plus a per-turn loop
-- over free-text names.
--
-- The other fields 0045 stored (title, place, date) had no reader in chat: the
-- device renders a private track's title from its own library copy, and search
-- never looked at them. Metadata for user tracks is owned by the orchestrator
-- and the profile service; chat keeps only what retrieval needs.

DROP TABLE IF EXISTS user_track_facts;
