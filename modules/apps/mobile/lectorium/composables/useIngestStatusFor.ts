import { useI18n } from "vue-i18n"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"

/** What a lecture being fetched is doing, ready to hand to the progress badge. */
export interface IngestStatus {
  readonly kind: "pending" | "failed"
  /** The stage, named: "Downloading" / "Transcribing" / … Never empty. */
  readonly label: string
  /** 0-100 while downloading; undefined for stages with no measure. */
  readonly percent?: number
}

/**
 * Where a lecture is in the pipeline, by the URL it was added from.
 *
 * Matching is by the deterministic job id rather than the source URL: the row
 * exists from the moment the submit returns, and until it syncs it carries no
 * `sourceUrl` at all — so looking it up by source misses exactly the window the
 * badge is for, and the badge then shows a ring with nothing written on it.
 *
 * That rule was worked out for the chat card and lived inside it. Both surfaces
 * that offer a lecture now read it from here, so "what stage is it at" is
 * answered the same way wherever it is asked.
 *
 * `undefined` means there is nothing to report: never added, or finished.
 */
export function useIngestStatusFor(): (url: string | undefined) => IngestStatus | undefined {
  const library = useLibraryStore()
  const { t, te } = useI18n()

  return function ingestStatusFor(url: string | undefined): IngestStatus | undefined {
    if (!url) return undefined
    const id = library.ingestIdForUrl(url)
    if (!id) return undefined
    const status = library.getById(id)?.status
    if (status === "ready") return undefined // done → the card's checkmark
    if (status === "failed") return { kind: "failed", label: t("library.status.failed") }
    // queued / processing, or just-submitted before its row synced. The ring
    // carries the percent, so the label is the stage name on its own.
    const stage = library.liveStages.get(id)
    const key = stage ? `library.status.stages.${stage}` : ""
    const label = key && te(key) ? t(key) : t("library.status.processing")
    return { kind: "pending", label, percent: library.livePercents.get(id) }
  }
}
