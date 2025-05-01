<template>
  <TranscriptDialog
    v-model:open="isOpen" 
  >
    <LanguageSelector 
      v-if="langAvailable.length > 1"
      v-model:active="langActive"
      :languages="langAvailable"
      :allow-multiple="langAllowMultiple"
    />
    <TranscriptText
      :class="{
        'transcript-text': true,
        'on': showTranscript,
        'off': !showTranscript
      }"
      :sections="transcriptSections"
      :time="position"
      @rewind="onRewind"
    />
  </TranscriptDialog>
</template>

<script setup lang="ts">
import { watch, ref } from 'vue'
import { 
  TranscriptSection, TranscriptLanguage, TranscriptText,
  TranscriptDialog, TranscriptBlock, LanguageSelector, usePlayerControls,
  usePlayerTranscript, usePlayer
} from '@lectorium/mobile/player'
import { useDAL } from '@lectorium/mobile/app'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import type { Transcript, Track } from '@lectorium/dal/models'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const player = usePlayer()
const { position } = usePlayerControls()
const { isOpen, trackId } = usePlayerTranscript()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */



// List of selected languages of transcript to show
const langActive = ref<string[]>([])

// List of all languages transcript translated to
const langAvailable = ref<TranscriptLanguage[]>([])

// If there are multiple speakers in the transcript, user
// can select languages
const langAllowMultiple = ref<boolean>(false)

// Transcripts and sections to show
let transcripts: Record<string, Transcript> = {}
const showTranscript = ref(false)
const transcriptSections = ref<TranscriptSection[]>([])


/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(trackId, async (value) => {
  if (!value) return
  const track = await dal.tracks.getOne(value)
  if (!track) return
  await loadData(track)
})

watch(langActive, async (value: string[]) => {
  showTranscript.value = false
  setTimeout(async () => {
    transcriptSections.value = await loadTranscriptBlocks(value, transcripts)
    showTranscript.value = true
  }, 200)
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onRewind(time: number) {
  player.seek({ position: time })
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function loadData(
  track: Track
) {
  // Get original language
  const langOriginal = 
    track.languages
      .find(x => x.source === 'track' && x.type === 'original')
      ?.language || track.languages[0].language || 'en'

  // load transcripts
  transcripts = await getTransciptFiles(
    Object.entries(track.transcripts).map(([lang, { path }]) => ({
      lang, path,
    }))
  )

  // Load languages and set original
  langAvailable.value = await getAvailableLanguages(
    track.languages.map((lang) => lang.language)
  )

  // Allow to select multiple languages if there several
  // original languges in the track
  langAllowMultiple.value = track.languages
    .filter(x => x.type === 'original')
    .length > 1

  langActive.value = [langOriginal]
}

async function getAvailableLanguages(
  codes: string[]
) {
  const languageItems = await dal.languages.getMany({
    selector: { code : { $in: codes } },
  })
  return languageItems.map((lang) => ({
    code: lang.code,
    name: lang.fullName,
    icon: lang.icon,
  })) 
}

async function getTransciptFiles(
  transcriptInfos: { lang: string, path: string }[]
): Promise<Record<string, Transcript>> {
  const results: Record<string, Transcript> = {}
  
  await Promise.all(
    transcriptInfos.map(async (info) => {
      const file = await Filesystem.readFile({
        path: info.path,
        directory: Directory.External,
        encoding: Encoding.UTF8,
      })
      results[info.lang] = JSON.parse(file.data as string) as Transcript
    })
  )

  return results
}

async function loadTranscriptBlocks(
  languages: string[],
  transcripts: Record<string, Transcript>
) {
  // enrich the transcript blocks with the speaker information
  const transcriptBlocks: TranscriptBlock[] = []
  for (const lang of languages) {
    transcriptBlocks.push(
      ...transcripts[lang].blocks.map(x => ({ ...x, speaker: lang }))
    )
  }

  const sortedTranscriptBlocks = transcriptBlocks.sort((a, b) => {
    if (a.start < b.start) return -1
    if (a.start > b.start) return 1
    return 0
  })

  // convert transcript to sections
  let blocksAdded = 0
  let lastBlockEnd = 0

  const sections = []
  let lastSection: TranscriptBlock[] = []
  for (const block of sortedTranscriptBlocks) {
    if (block.type === 'paragraph' || blocksAdded > 5) {
      sections.push({ blocks: lastSection })
      lastSection = []
      blocksAdded = 0
    }
    blocksAdded++
    if (block.type !== 'paragraph') {
      lastSection.push({ ...block, ...{ start: lastBlockEnd } })
      lastBlockEnd = block.end
    }
  }
  if (lastSection.length > 0) {
    sections.push({ blocks: lastSection })
  }
  return sections
}
</script>

<style scoped>
.transcript-text {
  transition: all .2s linear;
}

.off {
  opacity: 0;
}

.on {
  opacity: 1;
}
</style>