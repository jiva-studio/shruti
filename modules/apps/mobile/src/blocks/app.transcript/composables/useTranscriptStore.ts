import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { TranscriptLanguage, TranscriptBlocksGroupView } from '../models'


export const useTranscriptStore = defineStore('transcript', () => {
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const open = ref(false)
  const title = ref<Record<string, string>>({})
  const author = ref<Record<string, string>>({})
  const transcript = ref<TranscriptBlocksGroupView[]>([])
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
          blocks: paragraph.blocks.filter(block => 
            activeLanguages.value.includes(block.language)
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
    transcript.value.flatMap(x => x.blocks).forEach(x => x.selected = false)
  }

  function bookmark(startTime: number, endTime: number) {
    transcript.value
      .flatMap(x => x.blocks)
      .filter(x => x.block.start >= startTime && x.block.end <= endTime)
      .forEach(x => x.bookmarked = true)
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
    bookmark,
    isLoading,
  }
})