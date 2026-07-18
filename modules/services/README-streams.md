# Event streams (Redis Streams broker)

The personal-library services (`orchestrator`, `chat`, `profile`) talk to each
other **only** through a broker — no point-to-point internal HTTP. The broker is
a **dedicated** Redis-Streams instance (`redis-streams` in
`infra/app/compose/docker-compose.yml`), reachable at `STREAMS_REDIS_URL`
(`redis://redis-streams:6379/0`).

It is deliberately separate from the shared cache `redis`. The cache runs
`--maxmemory-policy volatile-lru` with a 1 GB cap; stream entries carry **no
TTL**, so on the cache they would never be eligible for eviction and Redis would
OOM — taking chat's L2 cache down with it. The broker instead runs
`--maxmemory-policy noeviction` with `appendonly yes`, so undelivered entries are
never silently dropped and survive a restart. Bounded memory is enforced by the
producers (see MAXLEN below), not by eviction.

## Streams

| Stream             | Producer → Consumer      | Payload |
| ------------------ | ------------------------ | ------- |
| `ingest.request`   | chat → orchestrator      | A user's request to ingest a lecture (URL / search hit) into their private library. |
| `track.events`     | orchestrator → chat, profile | Per-track lifecycle: `queued` / `processing` / `ready` / `failed` / `linked`. Fan-out: profile projects status into `library_items`; chat indexes the transcript for RAG. |
| `library.unlinked` | profile → chat           | A user removed a track from their library; chat drops the corresponding private RAG chunks. |

## Consumer-group conventions

- **One consumer group per consuming service, per stream.** Name the group after
  the consuming service, not the stream: e.g. group `chat` and group `profile`
  both read `track.events` independently, each with its own delivery cursor.
- Each running container is a **consumer** within its group, named by its
  instance id (e.g. hostname). Redis load-balances new entries across live
  consumers and tracks per-consumer pending (unacked) entries.
- Create groups with `XGROUP CREATE <stream> <group> $ MKSTREAM` (idempotent —
  ignore `BUSYGROUP`). Read with `XREADGROUP GROUP <group> <consumer> COUNT n
  BLOCK <ms> STREAMS <stream> >`.
- On startup / periodically, reclaim entries stuck in another consumer's PEL with
  `XAUTOCLAIM` (or `XPENDING` + `XCLAIM`) so a crashed consumer's in-flight work
  is redelivered.

## Delivery contract

Delivery is **at-least-once**. Every consumer must therefore be safe to run
against a redelivered entry.

1. **`XACK` after commit, never before.** Acknowledge an entry only once its
   side effects are durably committed. Ack-before-work loses messages on a
   crash; work-without-ack redelivers forever.
2. **Idempotent consumers (mandatory).** Redelivery WILL happen (crash between
   commit and `XACK`, `XAUTOCLAIM` of a slow consumer, at-least-once semantics).
   Key every handler on a stable id (the track id / event id in the payload) and
   make the side effect a no-op the second time — upsert, `ON CONFLICT DO
   NOTHING`, or a dedupe/`processed_events` table. Never assume exactly-once.
3. **`MAXLEN ~ N` trimming (mandatory).** Every `XADD` MUST cap the stream:
   `XADD <stream> MAXLEN ~ <N> * <fields…>`. The `~` (approximate) trim is far
   cheaper than exact and is what keeps broker memory bounded under
   `noeviction` — without it `XADD` eventually fails at the maxmemory ceiling.
   Pick `N` per stream from its expected in-flight + replay window.

## Producer pattern: transactional outbox

Producers MUST NOT `XADD` inline with their business write — a crash between the
DB commit and the `XADD` (or vice-versa) silently drops or duplicates the event.
Instead:

1. In the **same DB transaction** as the business write, insert the event row
   into a local `outbox` table.
2. A separate relay loop reads unpublished outbox rows, `XADD`s them to the
   broker (with `MAXLEN ~ N`), and marks them published — retrying on failure.

This makes the DB the source of truth: the event is published if and only if the
business write committed, and the relay's at-least-once retries are absorbed by
the idempotent consumers above.
