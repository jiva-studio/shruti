import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { TranscriptLanguage, TranscriptParagraph } from '../models'


export const useTranscriptStore = defineStore('transcript', () => {
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const open = ref(false)
  const transcript = ref<TranscriptParagraph[]>([])
  const activeLanguages = ref<string[]>([])
  const availableLanguages = ref<TranscriptLanguage[]>([])
  const allowMultipleLanguages = ref<boolean>(false)

  /* -------------------------------------------------------------------------- */
  /*                                   Getters                                  */
  /* -------------------------------------------------------------------------- */

  const isOpen = computed(() => open)
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


  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function toggleTranscriptOpen() {
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
    isOpen,
    transcript, 
    activeLanguages,
    availableLanguages,
    allowMultipleLanguages,
    localizedTranscript,
    toggleTranscriptOpen,
    removeSelection,
    highlight,
    removeHighlights,
  }
})