-- Concise summary of a lecture's transcript/content generated during normalization.
ALTER TABLE discovery.items ADD COLUMN IF NOT EXISTS summary text;
