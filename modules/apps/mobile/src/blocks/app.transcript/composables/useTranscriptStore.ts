import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { TranscriptLanguage, TranscriptParagraph } from '../models'


export const useTranscriptStore = defineStore('transcript', () => {
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const open = ref(false)
  const title = ref<Record<string, string>>({})
  const author = ref<Record<string, string>>({})
  const transcript = ref<TranscriptParagraph[]>([])
  const activeLanguages = ref<string[]>([])
  const availableLanguages = ref<TranscriptLanguage[]>([])
  const allowMultipleLanguages = ref<boolean>(false)
  const isLoading = ref<boolean>(false)

  /* -------------------------------------------------------------------------- */
  /*                                   Getters                                  */
  /* -------------------------------------------------------------------------- */

  const localizedTranscript = computed(() => {
    return transcript.value
      .map(paragraph => {
        return {
          ...paragraph,
          sentences: paragraph.sentences.filter(sentence => 
            activeLanguages.value.includes(sentence.language)
          )
        }
      })
  })

  const localizedTitle = computed(() => {
    const lang = activeLanguages.value[0] || 'en'
    return title.value[lang] || title.value['en'] || Object.values(title.value)[0] || ''
  })

  const localizedAuthorName = computed(() => {
    const lang = activeLanguages.value[0] || 'en'
    return author.value[lang] || author.value['en'] || Object.values(author.value)[0] || ''
  })


  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function toggleTranscriptOpen() {
    open.value = !open.value
  }

  function removeSelection() {
    transcript.value.flatMap(x => x.sentences).forEach(x => x.selected = false)
  }

  function highlight(blocks: string[]) {
    const sentences = transcript.value.flatMap(x => x.sentences)
    for (const block of blocks) {
      const sentence = sentences.find(x => x.id === block)
      if (sentence) { sentence.highlighted = true }
    }
  }

  function removeHighlights(blocks: string[]) {
    const sentences = transcript.value.flatMap(x => x.sentences)
    for (const block of blocks) {
      const sentence = sentences.find(x => x.id === block)
      if (sentence) { sentence.highlighted = false }
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { 
    open,
    title,
    author,
    transcript, 
    activeLanguages,
    availableLanguages,
    allowMultipleLanguages,
    localizedTranscript,
    localizedAuthorName,
    localizedTitle,
    toggleTranscriptOpen,
    removeSelection,
    highlight,
    removeHighlights,
    isLoading,
  }
})