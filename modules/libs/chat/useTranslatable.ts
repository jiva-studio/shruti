import { computed, ref, type ComputedRef, type Ref } from "vue"

/** A quote whose shown text may be a machine translation of an original. */
export interface TranslatableBody {
  readonly text: string
  readonly mt?: boolean
  readonly textOriginal?: string
}

export interface UseTranslatable {
  /** True when the shown text is a machine translation with an original to
   *  flip to (i.e. the TranslationNotice toggle is meaningful). */
  isMt: ComputedRef<boolean>
  /** User toggle: render the verbatim original instead of the translation. */
  showOriginal: Ref<boolean>
  /** What to render: the original when toggled (and available), otherwise the
   *  shown (possibly translated) text. */
  displayText: ComputedRef<string>
}

/**
 * Shared "show original ↔ translation" toggle for the text-shaped chat cards
 * (CitationCard, CommentaryCard) whose body carries `text` + optional `mt` /
 * `textOriginal`. VerseCard's per-locale translation map is a different shape
 * and keeps its own logic.
 */
export function useTranslatable(body: () => TranslatableBody | null | undefined): UseTranslatable {
  const showOriginal = ref(false)

  const isMt = computed<boolean>(() => {
    const b = body()
    return !!b?.mt && !!b?.textOriginal
  })

  const displayText = computed<string>(() => {
    const b = body()
    if (!b) return ""
    return isMt.value && showOriginal.value && b.textOriginal ? b.textOriginal : b.text
  })

  return { isMt, showOriginal, displayText }
}
