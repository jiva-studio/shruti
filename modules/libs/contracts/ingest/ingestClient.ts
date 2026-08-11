/**
 * Ingest control-plane **wire protocol** — the transport contract between the
 * mobile / web clients and the orchestrator Go service (`POST
 * /orchestrator/run`, `GET /orchestrator/run/{id}`).
 *
 * These types are hand-authored and mirror the Go handler exactly, in the JSON
 * shape the server emits (snake_case). They live in `@lib/contracts` (the
 * dependency-free shared kernel) for the same reason the sync/chat contracts do:
 * the port below is consumed by application code (the library store / retry
 * flow) and implemented by an infrastructure adapter (`@infra/ingest/http/*`).
 *
 * Scope: **pure transport**. `state` mirrors the client library lifecycle
 * vocabulary the orchestrator maps to (`queued/processing/ready/failed`), and
 * `error` is the stable failure code, never a raw internal message.
 */

/** Job lifecycle state, in the same vocabulary as `library_items.status`. */
export type IngestState = "queued" | "processing" | "ready" | "failed" | "cancelled"

/** Operation a run performs; `op` defaults to `"ingest"` when omitted. */
export type RunOp = "ingest" | "translate"

/**
 * `POST /orchestrator/run` request — one generic entry for every orchestrated
 * operation. `op="ingest"` reads url/title/author; `op="translate"` reads
 * membership_id + track/source_lang/target_lang (translate an already-ingested
 * track into a new language).
 */
export interface IngestSubmitRequest {
  readonly op?: RunOp
  readonly url?: string
  readonly title?: string
  readonly author?: string
  readonly translate_langs?: readonly string[]
  readonly membership_id?: string
  readonly track?: string
  readonly source_lang?: string
  readonly target_lang?: string
}

/**
 * `POST /orchestrator/run` response: the deterministic run id (poll it for live
 * status), the library membership id (`library_items.id`) the run advances — for
 * an ingest run these are equal — and the run's current state.
 */
export interface IngestSubmitResponse {
  readonly run_id: string
  readonly membership_id: string
  readonly state: IngestState
}

/** `GET /orchestrator/run/{id}` response — the job's live status. */
export interface IngestStatusResponse {
  readonly state: IngestState
  readonly attempts: number
  /** Stable failure code (e.g. "unavailable"), present only on a failed job. */
  readonly error?: string
  /** Content hash, present once the fetch step has computed it. */
  readonly track_id?: string
  /** Granular pipeline stage while processing (downloading / transcribing /
   *  reviewing / storing) — poll-only, shown live, never persisted. */
  readonly stage?: string
  /** Download completion (0-100), present only on the downloading stage —
   *  poll-only, refines the stage label ("Downloading 40%"). */
  readonly percent?: number
}

/**
 * Transport port: submit a lecture for ingest and poll a job's live status. The
 * single client→server entry to the pipeline (the chat transport is retired).
 */
export interface IIngestClient {
  submit(req: IngestSubmitRequest): Promise<IngestSubmitResponse>
  status(jobId: string): Promise<IngestStatusResponse>
}
