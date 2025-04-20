<template>
  <!-- Floating player -->
  <PlayerControls
    :playing="isPlaying"
    :title="title"
    :author="author"
    :class="{
      'player': true,
      'closed': !isPlayerTranscriptOpen,
      'opened': isPlayerTranscriptOpen,
      'hidden': !isVisible
    }"
    @play="togglePause"
    @click="isPlayerTranscriptOpen = !isPlayerTranscriptOpen"
  />

  <!-- Transcript dialog -->
  <TranscriptDialog
    v-model:open="isPlayerTranscriptOpen" 
  >
    <LanguageSelector 
      :languages="languages"
      :active-language="activeLanguage"
      @change-language="onChangeLanguage"
    />
    <TranscriptText
      :sections="sections"
      :time="position"
      @rewind="onRewind"
    />
  </TranscriptDialog>
</template>

<script setup lang="ts">
import { computed, watch, ref } from 'vue'
import { 
  PlayerControls, TranscriptSection, TranscriptLanguage, TranscriptText,
  TranscriptDialog, TranscriptBlock, LanguageSelector, usePlayerControls,
  usePlayerTranscript, usePlayerControlsPlayerScenario, usePlayer
} from '@/player'
import { useDAL } from '@/app'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import type { Transcript, Track } from '@lectorium/dal/models'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const player = usePlayer()
const dal = useDAL()
const { isPlaying, title, author, position } = usePlayerControls()
const { isOpen: isPlayerTranscriptOpen, trackId } = usePlayerTranscript()
const { togglePause } = usePlayerControlsPlayerScenario()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isVisible = computed(() => {
  return title.value !== '' || author.value !== ''
})

let track: Track | undefined = undefined
const sections = ref<TranscriptSection[]>([])
const languages = ref<TranscriptLanguage[]>([])
const activeLanguage = ref<string>('')

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(trackId, async (value) => {
  if (!value) return
  track = await dal.tracks.getOne(value)
  if (!track) return
  
  const language = 
    track.languages
      .find(x => x.source === 'track' && x.type === 'original')
      ?.language 
    || track.languages[0].language 
    || 'en'
  languages.value = await getAvailableLanguages(track)
  sections.value = await loadTranscriptBlocks(track, language)
  activeLanguage.value = language
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onRewind(time: number) {
  player.seek({ position: time })
}

async function onChangeLanguage(lang: string) {
  if (!track) return
  sections.value = await loadTranscriptBlocks(track, lang)
  activeLanguage.value = lang
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function getAvailableLanguages(track: Track) {
  const languageCodes = track.languages.map((lang) => lang.language) 
  const languageItems = await dal.languages.getMany({
    selector: { code : { $in: languageCodes } },
  })
  return languageItems.map((lang) => ({
    code: lang.code,
    icon: lang.icon,
  })) 
}

async function loadTranscriptBlocks(track: Track, language: string) {
  // load transcript file
  const result = await Filesystem.readFile({
    path: track.transcripts[language].path,
    directory: Directory.External,
    encoding: Encoding.UTF8,
  })
  const transcript = JSON.parse(result.data as string) as Transcript

  // convert transcript to sections
  const sections = []
  let lastSection: TranscriptBlock[] = []
  for (const block of transcript.blocks) {
    if (block.type === 'paragraph') {
      sections.push({ blocks: lastSection })
      lastSection = []
    } else {
      lastSection.push(block)
    }
  }
  if (lastSection.length > 0) {
    sections.push({ blocks: lastSection })
  }
  return sections
}
</script>

<style scoped>
.player {
  z-index: 100000;
  position: fixed;
  transition: all .5s ease-in-out;
}

.closed {
  bottom: calc(56px + var(--ion-safe-area-bottom));
  height: 58px;
  left: 16px;
  right: 16px;
  border-radius: 10px;
}

.opened {
  height: calc(56px + (var(--ion-safe-area-bottom)));
  padding-bottom: calc(var(--ion-safe-area-bottom));

  bottom: 0px; 
  left: 0px;
  right: 0px;
  border-top-left-radius: 5px;
  border-top-right-radius: 5px;
}

.hidden {
  opacity: 0;
  bottom: 0;
  pointer-events: none;
}
</style>
