-- Reverse 0039. Drop the notes table and any memory attributions (their
-- embeddings cascade via attribution_embeddings FK), then restore the
-- pinned/boost-only CHECK.
DROP TABLE IF EXISTS attribution_notes;
DELETE FROM attributions WHERE kind = 'memory';
ALTER TABLE attributions DROP CONSTRAINT attributions_kind_check;
ALTER TABLE attributions ADD CONSTRAINT attributions_kind_check CHECK (kind IN ('pinned', 'boost'));
