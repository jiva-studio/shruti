/**
 * Ingest control-plane **wire protocol** — the transport contract between the
 * mobile / web clients and the orchestrator Go service (`POST
 * /orchestrator/ingest`, `GET /orchestrator/ingest/{id}`).
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

/**
 * `POST /orchestrator/ingest` request. Only `url` is required; `title` / `author`
 * are optional hints a caller (e.g. chat discovery) resolved, seeding the
 * pipeline's metadata. Kept open for future optional hints.
 */
export interface IngestSubmitRequest {
  readonly url: string
  readonly title?: string
  readonly author?: string
}

/**
 * `POST /orchestrator/ingest` response: the deterministic job id — which is also
 * the library membership id (`library_items.id`) the client keys its row on —
 * and the job's current state.
 */
export interface IngestSubmitResponse {
  readonly job_id: string
  readonly state: IngestState
}

/** `GET /orchestrator/ingest/{id}` response — the job's live status. */
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
}

/**
 * Transport port: submit a lecture for ingest and poll a job's live status. The
 * single client→server entry to the pipeline (the chat transport is retired).
 */
export interface IIngestClient {
  submit(req: IngestSubmitRequest): Promise<IngestSubmitResponse>
  status(jobId: string): Promise<IngestStatusResponse>
}
