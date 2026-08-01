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

A shape nobody has tried outranks one that has proved barren, or a crawl would
only ever revisit what it already knows. Depth breaks ties, so one productive
shape is not chased downwards forever.

This does nothing on an archive that publishes a file tree: every directory is
its own shape, there is nothing to group, and the order falls back to the one
links came in. Pointing the seed at where the recordings are is still the
strongest lever there is.

## Not crawling by accident

Three separate things have to be true before anything is fetched on its own:

- `DISCOVERY_SCHEDULER_ENABLED=true` — off by default
- the source row is `enabled`
- a page is due by its `next_check_at`

Explicit requests ignore all of that: asking for one URL *is* the
authorization.

## Costing nothing on a re-run

- an unchanged page costs one conditional GET and no body
- a file whose normalizer input is byte-identical costs no model call, and the
  hash covers the prompt text and the model name, so changing either
  invalidates everything at once without anyone clearing a table
- an unchanged page's next visit doubles out: 1 day, 2, 4 … capped at 30, reset
  by any change

## Working on it

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
