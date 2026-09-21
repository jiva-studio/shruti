import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { IngestGatewayError } from "@ports/app/ingest.js"
import { useShruti } from "@shruti/shruti.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { languageLabel } from "@shruti/composables/transcriptLanguageLabels.js"
import { requestSync } from "@shruti/services/syncEvents.js"

export interface TranscriptTranslationDeps {
  /** Transcript languages the open track already has on disk. */
  readonly storedLanguages: Ref<readonly string[]> | ComputedRef<readonly string[]>
  /** Re-read the track once the translated variant has synced in. */
  readonly onVariantArrived: (trackId: string) => Promise<void>
  readonly onError: (key: string, params?: Record<string, unknown>) => void
  readonly onNotice: (key: string, params?: Record<string, unknown>) => void
}

export interface TranscriptTranslation {
  /** Languages the open track can be translated INTO — one ghost chip each. */
  readonly targets: ComputedRef<readonly string[]>
  /** Targets with a run in flight, so one chip spins while the rest stay
   *  tappable. */
  readonly running: Ref<Set<string>>
  translate: (code: string) => Promise<void>
}

/** On-demand translation of a personal-library track: request a run, follow it
 *  to an outcome, and wait for the produced variant to sync back. */
export function useTranscriptTranslation(deps: TranscriptTranslationDeps): TranscriptTranslation {
  const app = useShruti()
  const library = useLibraryStore()
  const transcriptStore = useTranscriptStore()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const translating = ref<Set<string>>(new Set())

  // The library item behind the currently open track (only a personal-library
  // track has one) — its id is the membership the translate run advances, and
  // its stored languages are the source to translate from.
  const libraryItem = computed(() => {
    const id = transcriptStore.trackId
    return id ? library.items.find((i) => i.trackId === id) : undefined
  })
  // The language to translate FROM: the first stored transcript (guaranteed to
  // exist on disk for the worker to read).
  const sourceLanguage = computed<string | undefined>(() => deps.storedLanguages.value[0])

  /**
   * The languages a personal-library track can be translated INTO — one ghost
   * chip each, so the user picks the target instead of being handed the single
   * implicit one (the interface language) the chip used to hardcode.
   *
   * The offer is the user's library content languages plus the interface
   * language: the set they have already declared they read. Deliberately not
   * every locale the app ships — fifteen chips in an inline row is a wall, and
   * most of them are languages this user will never open. The interface
   * language stays in the union so the offer is never narrower than before.
   *
   * A language already on this track is filtered out — the source it would be
   * translated from, and every stored transcript — so nothing can be requested
   * twice and land as a duplicate variant. Candidates are de-duplicated against
   * each other too: the interface language is usually a library language as well.
   * Interface language first, being the likeliest target.
   */
  const translationTargets = computed<readonly string[]>(() => {
    const source = sourceLanguage.value
    if (!libraryItem.value || !source) return []
    const taken = new Set<string>([source, ...deps.storedLanguages.value])
    const targets: string[] = []
    for (const code of [appLanguage.value, ...libraryLanguages.value]) {
      if (!code || taken.has(code)) continue
      taken.add(code)
      targets.push(code)
    }
    return targets
  })

  /**
   * Every way a run can end gets its own sentence: `failed` is the only error —
   * the chip stays on screen as the retry; `cancelled` means someone stopped it
   * on purpose; `pending` means WE stopped watching, not that the run died, so
   * the variant may still arrive through sync.
   */
  const OUTCOME_MESSAGE = {
    pending: { notice: true, key: "errors.translationStillRunning" },
    cancelled: { notice: true, key: "errors.translationCancelled" },
    failed: { notice: false, key: "errors.translationFailed" },
  } as const

  function reportOutcome(outcome: "pending" | "cancelled" | "failed", code: string): void {
    const { notice, key } = OUTCOME_MESSAGE[outcome]
    const params = { language: languageLabel(code) }
    if (notice) deps.onNotice(key, params)
    else deps.onError(key, params)
  }

  async function handleRunError(err: unknown, code: string): Promise<void> {
    if (err instanceof IngestGatewayError && err.code === "not_pro") {
      const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
      usePaywallStore().requestOpen()
      return
    }
    // Whatever the run threw — "ingest api responded 500", "HTTP 502" — is for
    // the console, not for a reader who asked for a translation.
    console.warn("[transcript] translation run failed:", err)
    deps.onError("errors.translationFailed", { language: languageLabel(code) })
  }

  // Request an on-demand translation of the track into `code`, poll the run, and
  // re-hydrate so the new language becomes a real, selectable transcript.
  async function onTranslateLanguage(code: string): Promise<void> {
    const trackId = transcriptStore.trackId
    const item = libraryItem.value
    const source = sourceLanguage.value
    if (!trackId || !item || !source) return
    // `translationTargets` is the authority on what may be requested, not just
    // what is drawn: an offer the UI no longer shows (the run finished and
    // synced while the chip was on screen) must not spend a second run.
    if (!translationTargets.value.includes(code) || translating.value.has(code)) return

    translating.value = new Set(translating.value).add(code)
    try {
      const res = await app.ingestClient.submit({
        op: "translate",
        membership_id: item.id,
        track: trackId,
        source_lang: source,
        target_lang: code,
        // Send the source title so the variant gets a translated title too (the
        // overview is generated from the translated blocks on the worker).
        title: item.titleRaw ?? undefined,
      })
      const outcome = await pollRun(res.run_id)
      if (outcome !== "ready") {
        reportOutcome(outcome, code)
        return
      }
      // The variant reaches THIS device through the normal sync — request a
      // pull, then wait for the library item to carry the new language.
      if (transcriptStore.trackId === trackId) {
        requestSync()
        await waitForSyncedVariant(trackId, code)
      }
    } catch (err) {
      await handleRunError(err, code)
    } finally {
      const next = new Set(translating.value)
      next.delete(code)
      translating.value = next
    }
  }

  // Resolve once the synced library item carries `code` (the translated variant
  // arrived through the sync), then re-hydrate so it becomes a selectable
  // transcript. A timeout fallback re-hydrates anyway — the data is never lost (a
  // re-open of the transcript would show it regardless).
  function waitForSyncedVariant(trackId: string, code: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const present = () =>
        library.items.some(
          (i) => i.trackId === trackId && i.variants.some((v) => v.language === code)
        )
      const finish = async () => {
        if (settled) return
        settled = true
        stop()
        clearTimeout(timer)
        if (transcriptStore.trackId === trackId) await deps.onVariantArrived(trackId)
        resolve()
      }
      const stop = watch(present, (yes) => {
        if (yes) void finish()
      })
      const timer = setTimeout(() => void finish(), 90000)
      if (present()) void finish()
    })
  }

  // Poll a translate run to completion. Bounded so a stuck run can't spin
  // forever; sync remains the authoritative fallback for the produced variant.
  // Every way the wait can end is reported as itself — the caller owes the user
  // a different sentence for each, and a boolean could carry only one of them.
  // `cancelled` is a state the orchestrator defines and can serve (job.State,
  // StatusLabel) even though nothing today drives a job into it: there is no
  // cancel endpoint, so it can only arrive from operator action or a future
  // feature. Folding it into "failed" until then would have exactly one effect
  // the day it becomes reachable — telling the user their translation broke.
  async function pollRun(runId: string): Promise<"ready" | "failed" | "cancelled" | "pending"> {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      try {
        const s = await app.ingestClient.status(runId)
        if (s.state === "ready") return "ready"
        if (s.state === "failed") return "failed"
        if (s.state === "cancelled") return "cancelled"
      } catch {
        // Transient poll failure — retry next tick.
      }
    }
    return "pending"
  }

  return { targets: translationTargets, running: translating, translate: onTranslateLanguage }
}
