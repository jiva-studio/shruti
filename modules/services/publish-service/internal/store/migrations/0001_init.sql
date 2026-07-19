-- publish-service schema — the promotion-side track ledger + a transactional
-- outbox.
--
-- `tracks` is the SOURCE OF TRUTH for what this service has ingested from the
-- orchestrator's `track.ready` events and whether it has been promoted into the
-- published corpus. The periodic ticker reconciles it against the published
-- corpus catalog: a matched row flips `published` and an event is written to
-- `outbox` in the SAME transaction, so a crash never drops a `track.published`
-- announcement — a relay drains outbox -> stream.

CREATE SCHEMA IF NOT EXISTS publish;

-- One row per track the service learned about via `track.ready`. `metadata`
-- holds the raw event payload (title/source_url/…) verbatim so the pending.db
-- review artifact can be rebuilt without re-deriving it.
CREATE TABLE publish.tracks (
    track_id        text        PRIMARY KEY,
    owner_id        text,                                   -- requesting user
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    lang            text,
    audio_key       text,
    transcript_key  text,
    published       boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz
);
CREATE INDEX tracks_unpublished_idx ON publish.tracks (created_at) WHERE published = false;

-- Transactional outbox: the ticker appends `track.published` rows here in the
-- same tx as the `published` flip; a relay reads unpublished rows in order and
-- XADDs them to the broker, then stamps published_at. Delivery is at-least-once;
-- consumers are idempotent.
CREATE TABLE publish.outbox (
    seq          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    topic        text        NOT NULL,                      -- stream name, e.g. 'track.published'
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON publish.outbox (seq) WHERE published_at IS NULL;
