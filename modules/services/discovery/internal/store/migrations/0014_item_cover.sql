-- The picture an archive publishes for a recording.
--
-- A field like the title and the date, said by the script that read the page —
-- youtube.js holds the video's own id and builds the address from it. Working
-- it out later, by matching the shape of a URL, would be guessing at a fact
-- somebody already had, and every client that guessed for itself would be a
-- client that disagreed with the next.
ALTER TABLE discovery.items ADD COLUMN IF NOT EXISTS cover_url text;
