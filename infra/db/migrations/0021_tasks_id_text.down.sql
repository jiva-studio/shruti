-- Revert tasks.id back to uuid. Only safe if every row has a valid uuid
-- string — any row with a non-uuid id (e.g. share-video's "note_…" ids)
-- will fail the cast. Deliberately keep this strict so a downgrade can't
-- silently lose rows.
ALTER TABLE tasks ALTER COLUMN id DROP DEFAULT;
ALTER TABLE tasks ALTER COLUMN id TYPE uuid USING id::uuid;
ALTER TABLE tasks ALTER COLUMN id SET DEFAULT gen_random_uuid();
