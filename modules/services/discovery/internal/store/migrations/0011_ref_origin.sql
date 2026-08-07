-- A reference says where it came from. Without this, references a repair pass
-- wrote and references a crawl wrote are the same rows, so a pass that got it
-- wrong can only be undone by restoring the database — and "we looked and this
-- recording cites nothing" cannot be told from "nobody has looked yet".
ALTER TABLE discovery.item_refs ADD COLUMN IF NOT EXISTS origin text;
