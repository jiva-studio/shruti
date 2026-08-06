-- Discovery indexes lecture audio published on external archives: which
-- recordings exist, what each is about, where it lives. It does not mirror the
-- audio and does not transcribe it.
--
-- The service owns this database outright.

CREATE SCHEMA IF NOT EXISTS discovery;
CREATE EXTENSION IF NOT EXISTS vector;

-- A source is an archive we were pointed at, and the manners we owe it.
CREATE TABLE IF NOT EXISTS discovery.sources (
    id             text PRIMARY KEY,
    title          text NOT NULL DEFAULT '',
    seed_urls      text[] NOT NULL,
    enabled        boolean NOT NULL DEFAULT false,
    -- The gap left between requests. The gap actually used is the largest of
    -- this, the service default and whatever robots.txt asked for: a source can
    -- be told to go gently, never to go faster.
    crawl_delay_ms integer NOT NULL DEFAULT 1000,
    -- How many pages of this source may be in flight at once.
    --
    -- The gap above is what bounds how hard we lean on a host; workers only
    -- stop us idling through somebody else's round trip. With a one second gap
    -- and a one second reply, one worker fetches a page every two seconds and
    -- two fetch one a second — after which the gap is the ceiling and more
    -- workers buy nothing.
    crawl_workers  integer NOT NULL DEFAULT 2,
    -- Zero means no bound. What stops a run running away is its page limit,
    -- not a guess about somebody else's tree.
    max_depth      integer NOT NULL DEFAULT 0,
    -- How soon a page of this source may be read again, and how far the wait
    -- may stretch when nothing keeps changing.
    --
    -- Between them the interval doubles: a page that changed is looked at again
    -- at the floor, and every visit that finds nothing new doubles the wait up
    -- to the ceiling. Left alone it settles on the page's own rhythm — a
    -- listing that gains something weekly never gets far from the floor, and a
    -- folder from 2008 goes quiet.
    --
    -- The floor is for an archive that would rather we came less often than
    -- daily; the ceiling for one where a month is too long to miss something.
    recheck_min_s  integer NOT NULL DEFAULT 86400,
    recheck_max_s  integer NOT NULL DEFAULT 2592000,
    -- Credentials, sent verbatim, so no scheme has to be understood here.
    auth_headers   jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Which reader gets this source. Empty is an ordinary HTTP request; "ytdlp"
    -- is for an archive that answers a plain GET with a page holding nothing,
    -- because what it holds is behind a JavaScript challenge.
    fetcher        text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery.pages (
    id            bigserial PRIMARY KEY,
    source_id     text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    url           text NOT NULL UNIQUE,
    -- url_key is what makes two addresses the same page: the scheme dropped and
    -- the trailing slash trimmed, because a host that redirects http to https
    -- serves one page under two names.
    url_key       text,
    etag          text,
    last_modified text,
    body_sha256   text,
    -- The set of media URLs found. A listing whose markup churns but whose
    -- files are the same has not changed for our purposes.
    item_set_sha256 text,
    http_status   integer,
    error         text,
    last_fetched_at timestamptz,
    last_changed_at timestamptz,
    -- Drives the backing off from a day to a month, and the reset on change.
    consecutive_unchanged integer NOT NULL DEFAULT 0,
    -- The same idea for the other outcome. A page that keeps failing was
    -- retried hourly for ever, which is a lot of requests at somebody's site
    -- for an address that has been gone since 2019, and no way to find it: a
    -- run's error tally is per-run and the empty-pages view mixes failures in
    -- with menus.
    consecutive_failures integer NOT NULL DEFAULT 0,
    next_check_at timestamptz,
    norm_prompt_version text,
    -- How many recordings this page offered, and how many of its links reached
    -- one when we last asked whether it presents a cycle.
    media_found       integer NOT NULL DEFAULT 0,
    series_links_seen integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS pages_due_idx ON discovery.pages (next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_source_idx ON discovery.pages (source_id);
CREATE INDEX IF NOT EXISTS pages_url_key_idx ON discovery.pages (url_key);
CREATE INDEX IF NOT EXISTS pages_no_media_idx ON discovery.pages (last_fetched_at) WHERE media_found = 0;

-- What a page pointed at. Kept for every page: it is what a cycle is decided
-- from later, and how the crawl walks through a page it is not due to fetch.
CREATE TABLE IF NOT EXISTS discovery.page_links (
    page_id bigint NOT NULL REFERENCES discovery.pages(id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    url     text NOT NULL,
    url_key text,
    PRIMARY KEY (page_id, ordinal)
);

CREATE INDEX IF NOT EXISTS page_links_url_key_idx ON discovery.page_links (url_key);

-- One recording.
CREATE TABLE IF NOT EXISTS discovery.items (
    id          bigserial PRIMARY KEY,
    media_url   text NOT NULL UNIQUE,
    source_id   text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    page_id     bigint REFERENCES discovery.pages(id) ON DELETE SET NULL,
    -- Everything extraction found: filename, path segments, the text around the
    -- link, container tags. It is the normalizer's input, kept so a prompt
    -- change can be replayed without refetching.
    raw         jsonb NOT NULL DEFAULT '{}'::jsonb,

    title       text,
    -- The speaker exactly as the archive wrote it, and the key that says who
    -- that is. Both are computed by the code; the vocabulary of Vaishnava
    -- forms of address lives there and not here.
    author      text,
    author_key  text,
    location    text,
    recorded_on date,
    language    text,
    duration_s  integer,
    -- What this recording's own page called the cycle it belongs to. On an
    -- archive with no page for the series it is the only route to the grouping.
    collection_title text,

    -- "present", or "vanished" when the address stopped appearing on its page.
    -- A vanished recording is still worth keeping: knowing a talk exists is not
    -- nothing, and a file can come back.
    media_state text NOT NULL DEFAULT 'present',
    media_seen_at timestamptz,
    media_missing_since timestamptz,

    -- Skip levers: rebuild the normalizer input, hash it, and do nothing when
    -- the hash, the prompt version and the model all match.
    norm_input_sha256   text,
    norm_prompt_version text,
    -- Who read this recording: "script" for a source's own extraction, or the
    -- name of the model that was asked instead.
    norm_model          text,
    -- What stopped the script, when it stopped. Empty for anything it read.
    --
    -- A set, not a choice: a line can lack a speaker and carry an unreadable
    -- date and leave words unaccounted for, all at once. Recording only the
    -- first would make a fix for one of them look like it changed nothing.
    norm_reasons        text[],

    status        text NOT NULL DEFAULT 'discovered',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_source_idx ON discovery.items (source_id);
CREATE INDEX IF NOT EXISTS items_status_idx ON discovery.items (status);
CREATE INDEX IF NOT EXISTS items_page_idx   ON discovery.items (page_id);
CREATE INDEX IF NOT EXISTS items_author_key_idx ON discovery.items (author_key) WHERE author_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_media_state_idx ON discovery.items (media_state) WHERE media_state <> 'present';

-- A talk is often about more than one passage, so references are rows. A range
-- in a filename is expanded before it gets here, the way the corpus does it.
CREATE TABLE IF NOT EXISTS discovery.item_refs (
    item_id   bigint NOT NULL REFERENCES discovery.items(id) ON DELETE CASCADE,
    ref_idx   integer NOT NULL,
    source_id text NOT NULL,
    tokens    text NOT NULL,
    PRIMARY KEY (item_id, ref_idx)
);

CREATE INDEX IF NOT EXISTS item_refs_lookup_idx ON discovery.item_refs (source_id, tokens);

CREATE TABLE IF NOT EXISTS discovery.runs (
    id          bigserial PRIMARY KEY,
    source_id   text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    dry_run     boolean NOT NULL DEFAULT false,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    -- A run killed mid-flight — a deploy, a restart — never learned when it
    -- stopped, only that it did. It stays unfinished and says why, rather than
    -- reading as still going for ever.
    interrupted boolean NOT NULL DEFAULT false,
    pages_fetched   integer NOT NULL DEFAULT 0,
    pages_unchanged integer NOT NULL DEFAULT 0,
    items_found     integer NOT NULL DEFAULT 0,
    items_new       integer NOT NULL DEFAULT 0,
    items_changed   integer NOT NULL DEFAULT 0,
    failures        integer NOT NULL DEFAULT 0,
    -- A tally by kind rather than a list, so a summary stays readable when one
    -- host is having a bad day.
    errors          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS runs_source_idx ON discovery.runs (source_id, started_at DESC);
