import { computed, type ComputedRef, type Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import type { Transcript } from "@lib/domain/transcript.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import {
  buildMergedTranscriptViewData,
  type NoteRange,
} from "@lectorium/composables/buildTranscriptViewData.js"
import type { UiTranscriptBlocksGroup } from "@ui/features/transcript/index.js"

export interface TranscriptViewDataDeps {
  readonly getTrack: () => Track | null | undefined
  readonly activeLanguages: Ref<readonly LanguageCode[]>
  /** Title to show when the active language has no variant of its own. */
  readonly fallbackTitle: Ref<string>
  readonly transcripts: Ref<
    readonly { readonly language: LanguageCode; readonly transcript: Transcript }[]
  >
  readonly notes: Ref<readonly NoteRange[]>
}

export interface TranscriptViewData {
  readonly description: ComputedRef<string | null>
  readonly chapters: ComputedRef<readonly TrackOutlineChapter[]>
  readonly title: ComputedRef<string>
  readonly blockGroups: ComputedRef<readonly UiTranscriptBlocksGroup[]>
}

/** Everything the reader renders: the lecture overview for the displayed
 *  language and the paragraph groups built from the loaded transcripts. */
export function useTranscriptViewData(deps: TranscriptViewDataDeps): TranscriptViewData {
  const appLanguage = useAppLanguage()
  const dictionaries = useDictionariesStore()

  // Auto-paragraph break threshold (chars). Bound to a user-tunable
  // setting so a future Settings screen can expose it; 350 is the chosen
  // default after eyeballing 30-min lectures (~5-10 paragraphs each).
  const paragraphChars = useConfig<number>("settings.transcript.paragraphChars", 350)

  // When several languages are shown at once, blocks group together across
  // languages (a sentence and its translation stay in one paragraph). Set true
  // to force a fresh paragraph at every language switch. No UI toggle — config-only.
  const breakParagraphOnLanguage = useConfig<boolean>(
    "settings.transcript.breakParagraphOnLanguageChange",
    false
  )

  // Lecture overview (description + chapter outline) for the displayed
  // language, rendered at the top of the transcript — the same data the track
  // bottom-sheet shows. Falls back to the playable variant when the active
  // language has no own variant. Declared before `blockGroups` because the
  // builder splits the transcript at these chapter boundaries.
  const overviewVariant = computed(() => {
    const track = deps.getTrack()
    if (!track) return null
    const lang = deps.activeLanguages.value[0]
    return track.variants.find((v) => v.language === lang) ?? pickPlayableVariant(track)
  })
  const description = computed<string | null>(() => overviewVariant.value?.description ?? null)
  const chapters = computed<readonly TrackOutlineChapter[]>(
    () => overviewVariant.value?.outline ?? []
  )
  // Title in the displayed language: a lecturer+translator recording shows the
  // translated title when its language is active, falling back to the track's.
  const title = computed<string>(() => overviewVariant.value?.title || deps.fallbackTitle.value)

  // A translation shows the same sentences in each language, aligned 1:1 (same
  // block count) — render it sentence-paired. A lecturer+translator recording has
  // different per-language content (different counts) and stays time-merged.
  const sentencePaired = computed(() => {
    const ts = deps.transcripts.value
    if (ts.length < 2) return false
    const n = ts[0].transcript.blocks.length
    return n > 0 && ts.every((t) => t.transcript.blocks.length === n)
  })

  const blockGroups = computed(() =>
    buildMergedTranscriptViewData(deps.transcripts.value, {
      paragraphChars: paragraphChars.value,
      sourcesById: dictionaries.sourcesById,
      lang: appLanguage.value,
      notes: deps.notes.value,
      chapters: chapters.value,
      breakOnLanguageChange: breakParagraphOnLanguage.value,
      sentencePaired: sentencePaired.value,
    })
  )

  return { description, chapters, title, blockGroups }
}
