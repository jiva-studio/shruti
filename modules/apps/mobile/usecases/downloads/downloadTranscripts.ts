import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import { err, ok, type Result } from "@kit/core"

export interface DownloadTranscriptsInput {
  readonly trackId: TrackId
  /**
   * Optional language allow-list. When omitted (or empty), every advertised
   * language is downloaded — the conservative default, used while the caller
   * does not yet KNOW what the user reads (the persisted selection has not
   * been read back). Once it does, it passes the set and we skip the rest.
   *
   * An allow-list that matches nothing advertised still yields one language
   * (the first advertised — the language the lecture was recorded in), so a
   * lecture saved for offline is never left with no transcript at all.
   */
  readonly languages?: readonly LanguageCode[]
}

/**
 * Per-language transfer callback. The use case is layer-pure — the actual
 * cache priming is a side effect of `ITranscriptRepository.get()` (which
 * routes through `IRemoteFilesStorage.get()` under the hood) — but we
 * accept a transfer function so the caller can inject a different policy
 * (e.g. a force-refetch) without touching the use case.
 */
export type TranscriptTransferFn = (trackId: TrackId, language: LanguageCode) => Promise<void>

export interface DownloadTranscriptsDeps {
  readonly transcripts: ITranscriptRepository
  readonly transfer: TranscriptTransferFn
}

export type DownloadTranscriptsError = "list-failed"

export interface DownloadTranscriptsOutcome {
  /** Languages whose transcript JSON is cached on disk after this run. */
  readonly cached: readonly LanguageCode[]
  /** Languages we tried but couldn't fetch — caller decides whether to retry. */
  readonly failed: readonly LanguageCode[]
}

/**
 * Download every advertised transcript for `trackId` (or only the subset
 * named in `input.languages`) so the Transcript dialog can render offline.
 *
 * Failures are collected — not thrown — so a single 404 in one language
 * doesn't sabotage caching the other languages we actually have. Callers
 * inspect `outcome.failed` and log/surface accordingly.
 *
 * The use case returns `err("list-failed")` only when *listing* the
 * languages itself blew up — that's the one case where we don't even
 * know what to attempt and silently completing would mask a content-DB
 * regression.
 */
export async function downloadTranscripts(
  input: DownloadTranscriptsInput,
  deps: DownloadTranscriptsDeps
): Promise<Result<DownloadTranscriptsOutcome, DownloadTranscriptsError>> {
  let advertised: readonly LanguageCode[]
  try {
    advertised = await deps.transcripts.availableLanguages(input.trackId)
  } catch {
    return err("list-failed")
  }

  const allowList = input.languages ?? []
  const wanted = allowList.length > 0 ? advertised.filter((l) => allowList.includes(l)) : advertised
  // Nothing the user reads is on offer (a Spanish lecture for a ru/en
  // reader). Keep the source language anyway: the dialog opens on it, and
  // the alternative — a downloaded lecture whose transcript is blank
  // offline — is worse than a few kilobytes.
  const requested = wanted.length > 0 ? wanted : advertised.slice(0, 1)

  const cached: LanguageCode[] = []
  const failed: LanguageCode[] = []
  // Sequential, not parallel: typical track has 1–3 transcript languages
  // and the bottleneck is server-side cold-cache latency; parallelising
  // would buy nothing but increase the chance of mid-flight cancellation
  // races on the shared `IRemoteFilesStorage` cache key.
  for (const language of requested) {
    try {
      await deps.transfer(input.trackId, language)
      cached.push(language)
    } catch {
      failed.push(language)
    }
  }
  return ok({ cached, failed })
}
