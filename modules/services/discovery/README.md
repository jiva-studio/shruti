# discovery

An index of lecture audio published on external archives: which recordings
exist, what each one is about, and where it lives.

It does **not** mirror audio and does **not** transcribe. Handing a discovered
media URL to the existing ingest pipeline is a separate, deliberate act.

## The one rule

**The engine contains no knowledge of any website.** A source is a seed URL and
politeness settings — nothing more. There are no selectors, no per-site
adapters, no layout analysis and no template rules anywhere in this service.

What it does instead, for every response, whether HTML or JSON:

1. flatten it to the text a reader would see
2. collect every media URL in it, each with the text around where it appeared
3. hand that, plus the filename and the directory chain, to a model that says
   what the recording is
4. embed the text and store it

A site nobody has looked at works exactly as well as one someone has. That
property is the whole design, and anything site-shaped in Go breaks it.

## Layout

| Package | What it does |
|---|---|
| `internal/extract` | flattens HTML/JSON to text; finds media URLs and their context windows |
| `internal/infra/fetch` | polite HTTP: robots.txt, per-host rate limit, conditional GET, circuit breaker |
| `internal/infra/embed` | batched embeddings, retried, dimension-checked |
| `internal/application/normalize` | model call that turns raw material into title/author/place/date/reference, with validation |
| `internal/application/parse` | single-URL dry run; writes nothing |
| `internal/application/index` | the write path, plus chunking and the recrawl schedule |
| `internal/application/crawl` | enumeration, the frontier, runs, and the scheduler |
| `internal/application/search` | vector + lexical search fused by reciprocal rank |
| `internal/store` | own schema, embedded migrations, repositories |

## Where the budget goes

Most of any site is scaffolding — menus, indexes, an account area — and taking
links in the order they appear spends a crawl there. Twenty pages from the root
of one archive found nothing at all; twenty from a page one level down found
four hundred files.

So the frontier is ordered by what pages of the same *shape* have actually
yielded, where a shape is the address with its numbers blanked. On one archive
`/audios/#` produced a file every time and `/authors/#` never did, and nobody
had to say so. The counts come from the pages table, seeded from earlier runs
and updated during the current one.

Going further into where the source was pointed outranks wandering out of it. A
source seeded at one speaker's Bhagavad-gita is a request to index that, not the
archive around it — and left to document order a crawl walks straight out,
because the breadcrumb to the parent and the site root sit above the chapter
directories in the markup. Twelve pages from such a seed went up and sideways
and found nothing; with the preference they went down eleven chapters and found
sixty-nine files.

A shape nobody has tried outranks one that has proved barren, or a crawl would
only ever revisit what it already knows. Depth breaks ties, so one productive
shape is not chased downwards forever. The yield is capped at one recording a
page: uncapped, a single page holding four hundred files would outweigh
everything else and drag a crawl out of the source it was given.

This does nothing on an archive that publishes a file tree: every directory is
its own shape, there is nothing to group, and the order falls back to the one
links came in. Pointing the seed at where the recordings are is still the
strongest lever there is.

A link to a page whose next check has not come around is not followed. Without
that the schedule applied only to where a run started, and every page reachable
by a link was refetched on every tick — so the backing off from one day to
thirty, the whole economy of recrawling, did nothing for them.

A crawl follows links as deep as they go. `max_depth` on a source bounds that,
but it defaults to no bound: setting it right needs advance knowledge of how
somebody else's site is laid out, which is the one thing this service is built
not to assume, and guessing it wrong silently truncates an archive. What stops
a run running away is its page limit. The bound is there for a site that
generates endlessly long addresses — a calendar with a perpetual "next month",
a faceted filter — which the visited set cannot catch because every address is
genuinely new.

A sitemap is read where a host publishes one, but only the part inside the
source. One archive lists four hundred and thirty-seven addresses; a source
pointed at one speaker's Bhagavad-gita wants its own dozen. Preferring what is
inside only orders the queue — once everything inside is up to date the rest is
all that is left, and the crawl wanders off into the archive.

## Not crawling by accident

Three separate things have to be true before anything is fetched on its own:

- `SHRUTI_DISCOVERY_SCHEDULER_ENABLED=true` — off by default
- the source row is `enabled`
- a page is due by its `next_check_at`

Explicit requests ignore all of that: asking for one URL *is* the
authorization.

## How the scheduler works

It is not a periodic job. The queue is already in the database — addresses
nobody has visited, and pages whose next check has come around — and the
scheduler takes from it until there is nothing left, then waits and looks again.
New addresses go first: they are the reason a listing was re-read at all.

Nothing paces it but the gap between requests to one host, which lives in the
fetcher. `SHRUTI_DISCOVERY_SCHEDULER_WORKERS` says how many pages may be in flight at
once across every source; it stops us idling through somebody else's round trip
and is not a rate limit. There is no page budget: a batch on top of the per-host
gap would only delay work that was already due, and make two sources on
different hosts wait for each other though neither can disturb the other.

`/discovery/runs` records passes started by hand, and those now return at once:
the walk outlives the request that asked for it, and `/discovery/runs/{id}` is
where you watch it. One run per source at a time; pressing the button twice is
answered with `409` and the id of the run already going.

Work the scheduler does leaves no run behind — it has no beginning and no end to
record. `GET /discovery/status` is what stands in its place: what this process
has fetched, found, failed at and spent since it started, and how much is still
waiting. Two readings a minute apart give a rate.

### When a page is read again

A visit that finds something new schedules the next one at the source's
`recheck_min_s`; a visit that finds nothing doubles the wait, up to
`recheck_max_s`. A page settles on its own rhythm: a listing that gains
something weekly never gets far from the floor, because the visit that finds the
new thing puts it back there, while a folder from 2008 goes quiet.

A page inside a section `robots.txt` later closed leaves the queue for good,
with the reason on it. Left in place it would fill every claim and be discarded
afterwards, starving the work that could have been done.

A page that cannot be read at all is retried in an hour, then two, then four,
drifting out to about ten days and never past the source's `recheck_max_s`.
`GET /discovery/pages/empty?failing=true` is the list of them, worst first —
coming away empty and being refused are different things, and a menu is not a
problem.

### Only one replica crawls

The service takes a Postgres advisory lock at boot. The process that gets it
schedules; the others serve the whole API and do not crawl, and say so in the
log. Nothing needs configuring and nothing needs clearing if a process dies —
the lock is session-scoped.

This is not about duplicated work, which would be cheap. The per-host gap and
the circuit breaker are a map in one process's memory, so two crawlers are two
rate limiters, each correctly observing an interval the other knows nothing
about: a site that asked for one request a second gets two. Row locks would not
fix that; only shared limiter state would.

The lock covers the scheduler. A run started by hand fetches from whichever
replica received the request — rare, and somebody pressed a button.

### Shutting down

`SIGTERM` stops the scheduler claiming pages and stops hand-started runs taking
new ones, then waits up to 20 seconds for the pages in hand to finish writing.
The context they write under stays alive for that whole time: cancelling it is
what leaves a page written and its recordings not. Only if the drain runs out of
time is it cancelled. `stop_grace_period` is 45s, because the 10s default would
kill the drain every deploy.

## Settings

One name, everywhere: `SHRUTI_DISCOVERY_*` in the deployment `.env`, in
compose, and in the service. Compose passes the file through and states a
value only where it computes one — a password into a DSN, or one variable
standing in for another. The defaults below live in the service's own config
and nowhere else, which is what keeps them from disagreeing.

| variable | default | what it does |
|---|---|---|
| `SHRUTI_DISCOVERY_SCHEDULER_ENABLED` | `false` | the only switch that makes the service crawl on its own |
| `SHRUTI_DISCOVERY_SCHEDULER_WORKERS` | `4` | pages in flight at once, across every source — not a rate limit |
| `SHRUTI_DISCOVERY_PAGE_TIMEOUT` | `10m` | one page end to end: fetch, model, embed, write |
| `SHRUTI_DISCOVERY_DB_MAX_CONNS` | `16` | pool size; raised automatically if smaller than the worker count |
| `SHRUTI_DISCOVERY_USER_AGENT` | names us, with a contact URL | who a volunteer archive sees, and where to complain |
| `SHRUTI_DISCOVERY_CRAWL_DELAY` | `1s` | gap between requests to one host where `robots.txt` states none |
| `SHRUTI_DISCOVERY_REQUEST_TIMEOUT` | `30s` | one outbound request |
| `SHRUTI_DISCOVERY_MAX_BODY_BYTES` | `8388608` | the most of one response we will read |
| `SHRUTI_DISCOVERY_PROXY` | empty | for archives a datacenter address cannot read; YouTube answers one with a bot check |
| `SHRUTI_DISCOVERY_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | the endpoint; what decides whether the normalizer runs is the key below |
| `SHRUTI_DISCOVERY_LLM_API_KEY` | empty | unset leaves the normalizer stubbed: pages are still fetched and stored, just not read |
| `SHRUTI_DISCOVERY_LLM_MODEL` | `google/gemini-3.1-flash-lite` | part of the input hash, so changing it re-reads everything |
| `SHRUTI_DISCOVERY_EMBED_MODEL` | `openai/text-embedding-3-small` | matches the corpus, so vectors stay comparable |
| `SHRUTI_DISCOVERY_EMBED_DIM` | `1536` | must match the vector column or every insert fails |

Per-source settings — the crawl delay, worker count, recheck bounds, credentials
and which reader to use — live on the source row, not here.

## Costing nothing on a re-run

- an unchanged page costs one conditional GET and no body
- a file whose normalizer input is byte-identical costs no model call, and the
  hash covers the prompt text and the model name, so changing either
  invalidates everything at once without anyone clearing a table
- an unchanged page's next visit doubles out: 1 day, 2, 4 … capped at 30, reset
  by any change

## Working on it

Most of the suite is offline. The parts that are not — the store, the write
path, the scheduler, the HTTP surface, search — want a Postgres with pgvector
and skip without one. Any throwaway instance will do; these tests drop and
recreate the schema on every run, so do not point them at anything you want to
keep:

```sh
docker run -d --name disctest -p 55444:5432 \
  -e POSTGRES_USER=discovery -e POSTGRES_PASSWORD=x -e POSTGRES_DB=discovery \
  pgvector/pgvector:pg17

export SHRUTI_DISCOVERY_TEST_DATABASE_URL='postgresql://discovery:x@127.0.0.1:55444/discovery?sslmode=disable'
go test ./... -p 1                   # -p 1: they share one schema and drop it
```

`-p 1` is not optional with a database. Each of those packages starts from a
freshly migrated schema, and run in parallel they pull it out from under each
other, failing in ways that look like product bugs and are not.

```sh
go test ./...                        # offline, no keys, no database
discovery parse <url>                # fetch one URL, print the three layers
curl -XPOST :8089/discovery/parse -d '{"url": "..."}'
curl -XPOST :8089/discovery/parse -d '{"body": "<html>…", "base_url": "..."}'
```

`parse` returns three layers so a bad result shows you where it broke:
`extracted` (what came off the page), `normalizer_input` (exactly what the
model is asked, and what gets hashed), `normalized` (what it said, after
validation).

Locally:

```sh
docker compose -f infra/app/compose/docker-compose.yml --profile discovery-dev up
```

brings up just this service and its pgvector Postgres.

Without a model key the normalizer falls back to a stub and embeddings are
disabled: fetching, extraction and storage still work, the service just cannot
say what anything means.

## API

| | |
|---|---|
| `POST /discovery/parse` | one URL or one body, dry run, writes nothing |
| `POST /discovery/items` | one URL, processed and stored (`force` bypasses every skip) |
| `GET /discovery/sources` | what is configured, and whether anything will happen on its own |
| `POST /discovery/sources` | add or update a source |
| `POST /discovery/sources/{id}/run` | one pass by hand (`dry_run`, `limit`, `full`) |
| `GET /discovery/runs`, `/runs/{id}` | what recent passes cost |
| `GET /discovery/queue` | what is waiting for a recheck |
| `GET /discovery/pages/empty` | visits that found no file, and why when there was a why |
| `GET /discovery/collections` | cycles, their parts in order, and how many are still unindexed |
| `GET /discovery/search` | `q`, `author`, `language`, `source`, `ref`, `collection`, `date_from`, `date_to` |
| `POST /discovery/search` | a question in words; answers with the filter it was read into |

## Asking in words

`GET /discovery/search` takes filters. `POST /discovery/search` takes a
sentence, or filters, or both:

```json
{ "query": "лекции Шиварамы Свами за 2012 год о карме",
  "filter": { "language": "ru", "limit": 20 } }
```

and answers with the recordings, **the filter it read the sentence into**, and
the sentence itself unchanged:

```json
{ "query": "лекции Шиварамы Свами за 2012 год о карме",
  "filter": { "author": "Шиварама Свами", "date_from": "2012-01-01",
              "date_to": "2012-12-31", "language": "ru", "limit": 20 },
  "messages": [], "hits": [ … ] }
```

The filter is one model in both directions. That is the point: send it back with
the year removed and no `query`, and it behaves like the GET — dropping a field
does not mean rewriting the sentence and hoping it reads the same way twice.

Where the sentence and the filter disagree, **the sentence wins**: a filter is
what was set last time, a sentence is what is being said now. Every field it
overrules appears in `messages`, so an interface can say "year changed to 2012"
without diffing anything itself.

`messages` is also where the other answers about the question go. A speaker
nobody has keeps its filter and returns nothing, and says so — "nothing matches"
and "nothing could match" are different answers, and an empty list cannot tell
them apart on its own. A question that could not be read, because no model is
configured or the provider was slow, is searched as written and says that too.
The reading has six seconds and no retries: somebody is waiting, and results
without a reading beat a reading nobody stayed for.

A topic is not a filter. "о карме" describes what is said inside a talk, so it
stays in the text and is searched for. Nothing is cut out of the question,
including the speaker's name — the author filter already narrows, and a lecture
that mentions somebody is a reasonable thing to find.

## Sources behind an account

Some archives publish the page and gate the file: the address of the mp3 only
appears once you are signed in. A source therefore carries a map of headers,
sent with every request to it:

```sh
curl -XPOST :8089/discovery/sources -d '{
  "id": "example", "seed_urls": ["https://example.org/"],
  "auth_headers": {"Cookie": "session=…"}
}'
```

Headers cover every scheme worth supporting — a session cookie, a bearer token,
an API key — so nothing here needs to understand any of them. They go in and
never come back out: `GET /discovery/sources` omits them, and saving a source
without them leaves the stored ones alone rather than silently signing it out.

`POST /discovery/parse {"url": "...", "source": "example"}` borrows the same
credentials for a dry run. The `discovery parse` CLI has no database and so no
credentials — use the endpoint for a gated page.

Credentials belong to whoever runs the service, and a site that gates its audio
means it. Crawling an archive through a personal account is a different act
from a person listening, and is worth agreeing with the archive first.

## Cycles

A course or a seminar is stated on both sides: the series page lists its parts
in order, and each part names the series. Both are read, and they are
reconciled rather than trusted one at a time.

- A page that offers no media has its links stored, always. They are the raw
  material, and refetching to get them back is the expensive way to find out.
- It is asked whether it presents a series only when at least two of those
  links reach recordings we already have. Most pages on any site carry no
  audio — menus, sections, sign-in pages, the account pages of whoever we are
  signed in as — and a cycle is made of recordings, so a page that reaches none
  cannot be one. Without this gate the first twenty-five pages of one archive
  cost sixteen model calls and found nothing; with it, none.
- A counter remembers what the page reached when the question was last put, so
  a menu is never asked twice and a page whose parts have since been found is
  asked again.
- Membership is recorded by page address first and resolved to a recording
  whenever that page is indexed, so a series page can list parts that do not
  exist yet, and a part indexed first is picked up later. Neither side has to
  arrive before the other.
- A part that names its cycle where nothing lists the membership keeps the
  cycle under that name. When the series page turns up afterwards, the two are
  folded together: the page has the order and the full membership, so it takes
  over, keeping any part it did not list.

Order comes from the series page, not from the order things were indexed.

Both directions are answerable over HTTP, and they compose: a hit carries its
cycle's id, and that id is what `collection=` takes, so finding one lecture and
then pulling the rest of its course is two calls.

```json
{ "title": "Из чего складывается здоровье",
  "collection": { "id": 1, "title": "Ведическая концепция здоровья",
                  "url": "https://audioveda.ru/unions/507", "ordinal": 1, "of": 3 } }
```

With no query text the parts come back in the order the series page gave them,
so listing a cycle is the same endpoint as searching one:

```sh
curl -G :8089/discovery/search --data-urlencode 'collection=Ведическая концепция здоровья'
#  1/3  Из чего складывается здоровье     2013-12-29
#  2/3  Тело человека согласно аюрведе    2014-01-05
#  3/3  Режим еды, сна, отдыха и работы   2014-01-12
```

Groupings on file-tree archives — where the cycle is a directory and has no
page — are deliberately not attempted. A directory per collection would be
tens of thousands of rows of noise.

## When there is no file

Text and embeddings hang off a recording, so a page that offers no media URL
produces no record and nothing searchable. What it does leave is the page row:
we were there, when, and `media_found = 0`. That is enough to ask afterwards
which pages came up empty and go and look at why.

`GET /discovery/sources` counts both, per source:

```
audioveda  pages={visited: 1, empty: 1}  media={vanished: 1}
bgclass    pages={visited: 1, empty: 0}  media={present: 41}
```

Both numbers are counted from the rows themselves at read time — there is no
tally kept anywhere to drift out of step with what it describes.

A file that was on a page and is not any more is marked, never deleted:

| | |
|---|---|
| `media_state` | `present`, or `vanished` once the address stops appearing |
| `media_seen_at` | when the address was last on the page |
| `media_missing_since` | the FIRST visit that missed it, not the latest |

Whether a file was removed by the archive or our session simply lapsed cannot
be told apart at the moment it happens, and guessing would write our own login
trouble into the record as a fact about somebody else's site. The dates settle
it later without anyone having to decide on the spot: gone for an hour reads
differently from gone since spring. Seeing the file again clears the mark, and
nothing is re-read or re-embedded on the way — the last good reading stands.

## Not routed publicly

There is **no Caddy route** for `/discovery/*`, and that is deliberate: nothing
here authenticates, and `POST /discovery/sources/{id}/run` starts fetching
somebody else's website. Reach it from the origin host or over an SSH tunnel.
Exposing it would mean putting auth in front of it first.

## Manners

Every request names us and carries a contact URL. robots.txt is obeyed, and a
host that cannot serve its own robots.txt is treated as fully disallowed — a
bad day is not permission.

The gap between requests to one host is the largest of the service default, the
`Crawl-delay` that host asked for, and the source's own `crawl_delay_ms`. A
source can be told to go gently, never to go faster.

Bandwidth is not the concern people expect: a page is tens of kilobytes and a
lecture is thirty megabytes, so a two-hundred-page crawl costs an archive a
third of one download. What costs a dynamic site is *requests* — each page is a
query and a render, more work than streaming a static file.

When a host stops cooperating:

- 429 and 5xx are retried three times, backing off and honouring `Retry-After`
- five consecutive refusals — 401, 403, 429, 5xx, or no answer at all — drop
  the host for five minutes, then one probe decides whether it is back
- a 404 is **not** a refusal. Five dead links in a row must not stop us
  visiting a site that is answering perfectly well
- the moment a host is dropped is logged (`host_circuit_opened`), and a crawl
  that hits a dropped host stops rather than spending the rest of its budget on
  refusals it already knows the answer to

`pages_fetched` on a run counts requests that reached the host. A refusal that
never left the process is a failure, not a page.
