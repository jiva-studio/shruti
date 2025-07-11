import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useNavigationBar } from '@blocks/app.appearance'
import { useTranscriptStore } from '@blocks/app.transcript'

export function setupAppearanceFeature() {
  const navigationBar = useNavigationBar()
  const transcriptStore = useTranscriptStore()

  watch(storeToRefs(transcriptStore).open, (isOpen) => {
    navigationBar.setState(isOpen ? 'transcript' : 'normal')
  })

  
}