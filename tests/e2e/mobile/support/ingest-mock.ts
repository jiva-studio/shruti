import type { Page } from "@playwright/test"

/**
 * The personal library's control plane, offline.
 *
 * `orchestratorBaseUrl` points at the dead sink origin every mocked region
 * publishes, so until something answers `**​/orchestrator/run` the whole feature
 * is unreachable from a spec: the submit throws and `useIngestStatusPolling`
 * early-returns forever. This is that answer.
 *
 * Wire shape mirrors the CLIENT contract (`@lib/contracts/ingest`, snake_case,
 * as the Go handler emits it) — not the service's internals:
 *
 *   POST /orchestrator/run       → `{run_id, membership_id, state}`
 *   GET  /orchestrator/run/{id}  → `{state, attempts, stage?, percent?, track_id?, error?}`
 *
 * The second half of the feature is not on this API at all. `library_items` is
 * server-owned and reaches the device over profile-sync, and the poller only
 * looks at items it can already see — so a submit that nothing syncs down is
 * never polled. The mock therefore keeps a small change log and answers
 * `**​/profile/sync/pull` from it, appending the row the orchestrator would have
 * created. That is what makes the queued → downloading → transcribing → ready
 * ticker observable end to end.
 *
 * Progress is driven by the SPEC, not by a timer: every status poll returns the
 * script's current entry until {@link IngestMock.advance} moves to the next one.
 * A stage that only exists for one poll interval cannot be asserted without a
 * race, and a suite that races is a suite that gets re-run rather than read.
 */

export type IngestState = "queued" | "processing" | "ready" | "failed" | "cancelled"
export type LibraryItemStatus = "queued" | "processing" | "ready" | "failed"

/** One answer to `GET /orchestrator/run/{id}`. */
export interface IngestStatusStub {
  state: IngestState
  attempts?: number
  /** Granular pipeline stage while processing (downloading / transcribing / …). */
  stage?: string
  /** Download completion (0-100); only meaningful on the downloading stage. */
  percent?: number
  /** Content hash, present once the fetch step has computed it. */
  track_id?: string
  /** Stable failure code (e.g. "unavailable"), only on a failed run. */
  error?: string
}

/**
 * A `library_items` row as the profile service projects it. Only the fields a
 * spec ever varies are named here; {@link libraryItemChange} fills the rest with
 * the nulls the wire carries.
 */
export interface LibraryItemStub {
  id: string
  status: LibraryItemStatus
  title_raw?: string | null
  author_raw?: string | null
  source_url?: string | null
  track_id?: string | null
  error?: string | null
  cover_key?: string | null
  duration?: number | null
  lang?: string | null
}

/** What the app sent to `POST /orchestrator/run`. */
export interface IngestSubmitRecord {
  op?: string
  url?: string
  title?: string
  author?: string
  membership_id?: string
}

export interface IngestMockOptions {
  /** Rows already in the user's library when the app boots. */
  items?: LibraryItemStub[]
  /** The status sequence a run walks through, one entry per {@link IngestMock.advance}. */
  script?: IngestStatusStub[]
  /** Answer the submit with this status instead of 200 — the failure lane. */
  submitStatus?: number
  /** `error.code` in that failure envelope (`not_pro` bounces to the paywall). */
  submitErrorCode?: string
}

export interface IngestMock {
  /** Every submit the app made, in order. */
  readonly submits: IngestSubmitRecord[]
  /** Move every run on to the script's next entry. No-op at the end. */
  advance(): void
}

/**
 * The three-stage run every spec gets unless it asks for another: a download
 * that reports its completion, a transcription that has no measure to report,
 * and a finished lecture with its content hash.
 */
export const DEFAULT_INGEST_SCRIPT: IngestStatusStub[] = [
  { state: "processing", attempts: 1, stage: "downloading", percent: 40 },
  { state: "processing", attempts: 1, stage: "transcribing" },
  { state: "ready", attempts: 1, track_id: "hash-e2e-ingest" },
]

/** One change row of a `POST /profile/sync/pull` page. */
interface SyncChange {
  server_seq: number
  collection: string
  doc_id: string
  op: "upsert"
  data: Record<string, unknown>
  hlc: string
}

/** A full `library_items` wire row, defaults included, as one pull change. */
function libraryItemChange(item: LibraryItemStub, seq: number): SyncChange {
  return {
    server_seq: seq,
    collection: "library_items",
    doc_id: item.id,
    op: "upsert",
    data: {
      id: item.id,
      track_id: item.track_id ?? null,
      status: item.status,
      origin: "private",
      title_raw: item.title_raw ?? null,
      author_raw: item.author_raw ?? null,
      location_raw: null,
      date_raw: null,
      lang_hint: item.lang ?? "en",
      author_id: null,
      location_id: null,
      date: null,
      lang: item.lang ?? "en",
      error: item.error ?? null,
      audio_key: null,
      transcript_key: null,
      duration: item.duration ?? null,
      cover_key: item.cover_key ?? null,
      references: null,
      variants: null,
      source_url: item.source_url ?? null,
      created_at: 1_700_000_000_000 + seq,
      updated_at: 1_700_000_000_000 + seq,
    },
    // `<physical_ms>:<counter>:<device_id>`. Monotonic in `seq`, so a later
    // change for the same doc always wins the apply's last-write-wins compare.
    hlc: `${String(1_700_000_000_000 + seq).padStart(15, "0")}:00001:dev-e2e-server`,
  }
}

/**
 * Register the ingest routes on the PAGE (context routes lose to them, which is
 * how this overrides the suite-wide profile-sync stub). Returns the handle a
 * spec drives the run with.
 */
export async function installIngestMock(
  page: Page,
  options: IngestMockOptions = {}
): Promise<IngestMock> {
  const {
    items = [],
    script = DEFAULT_INGEST_SCRIPT,
    submitStatus,
    submitErrorCode = "not_pro",
  } = options

  const submits: IngestSubmitRecord[] = []
  const log: SyncChange[] = items.map((item, i) => libraryItemChange(item, i + 1))
  let cursor = 0
  let submitCount = 0

  function append(item: LibraryItemStub): void {
    log.push(libraryItemChange(item, log.length + 1))
  }

  await page.route("**/profile/sync/pull", (route) => {
    const from = readJson<{ cursor?: number }>(route.request().postData())?.cursor ?? 0
    const changes = log.slice(from)
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ changes, cursor: log.length, has_more: false }),
    })
  })

  await page.route("**/orchestrator/run", (route) => {
    const body = readJson<IngestSubmitRecord>(route.request().postData()) ?? {}
    submits.push(body)
    if (submitStatus !== undefined) {
      void route.fulfill({
        status: submitStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: submitErrorCode, message: `ingest rejected (${submitErrorCode})` },
        }),
      })
      return
    }
    // A re-add of a lecture the server already knows maps to the SAME run, which
    // is what makes a retry restart the job in place instead of duplicating it.
    const existing = body.url
      ? log.find((c) => (c.data.source_url as string | null) === body.url)
      : undefined
    const id = existing ? existing.doc_id : `run-e2e-${++submitCount}`
    // The row the orchestrator would have written, ready for the next sync page:
    // queued, and no longer carrying the failure a retry just cleared.
    append({
      id,
      status: "queued",
      title_raw: body.title ?? (existing?.data.title_raw as string | null) ?? null,
      author_raw: body.author ?? null,
      source_url: body.url ?? null,
      error: null,
    })
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ run_id: id, membership_id: id, state: "queued" }),
    })
  })

  await page.route("**/orchestrator/run/*", (route) => {
    const stub = script[Math.min(cursor, script.length - 1)] ?? { state: "queued" }
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ attempts: 1, ...stub }),
    })
  })

  return {
    submits,
    advance(): void {
      if (cursor < script.length - 1) cursor++
    },
  }
}

function readJson<T>(body: string | null): T | undefined {
  if (!body) return undefined
  try {
    return JSON.parse(body) as T
  } catch {
    return undefined
  }
}
