-- tasks.id from UUID to TEXT.
--
-- Original 0020_tasks shape assumed all task ids are server-generated UUIDs.
-- share-video accepts client-supplied video_id (the agent emits e.g.
-- "note_50hfcax6qU1J" and round-trips it through the share flow so the chat
-- bubble can re-poll without holding a separate id). With UUID-typed column
-- those INSERTs blow up with `invalid input syntax for type uuid`, which
-- (until the matching server.ts error-wrap fix) actually crashed the Node
-- process and surfaced as 502 on every /reels POST.
--
-- TEXT keeps the existing server-side default working — gen_random_uuid()
-- returns uuid which casts to text identically — and admits the broader
-- `[A-Za-z0-9_-]{1,64}` shape the GET /reels/:id validator already accepts.
ALTER TABLE tasks ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE tasks ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
