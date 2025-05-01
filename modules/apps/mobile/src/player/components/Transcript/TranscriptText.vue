<template>
  <div
    class="transcript-text"
  >
    <p
      v-for="(section, idx) in sections"
      :key="idx"
      :class="{
        'prompter': true,
        'paragraph': section.blocks[0]?.start <= time && section.blocks[section.blocks.length-1].end >= time
      }"
    >
      <Timestamp
        v-if="section.blocks[0]?.start"
        :start="section.blocks[0]?.start"
      />
      <component
        :is="'span'"
        v-for="(block, index) in section.blocks"
        :key="index"
        :lang="block.speaker"
        :class="{
          'highlight': block.start <= time && block.end >= time,
        }"
        @click="emit('rewind', block.start)"
      >
        <span
          v-if="shouldShowSpeakerAvatars"
          class="avatar"
        >
          {{ avatars[block.speaker] }}
        </span>
        {{ block.text + " " }}
      </component>
    </p>
  </div>
</template>

<script setup lang="ts">
import { watch, toRefs, ref } from 'vue'
import Timestamp from './Sections/Timestamp.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type TranscriptSection = {
  blocks: TranscriptBlock[]
}

export type TranscriptBlock = {
  type: 'sentence' | 'paragraph'
  text: string
  start: number
  end: number
  speaker: string
}

const props = defineProps<{
  sections: TranscriptSection[]
  time: number
}>()

const emit = defineEmits<{
  rewind: [time: number]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const speakers = ['👨‍🦲', '👨🏽‍💼', '👴', '👦', '👨🏽‍🦲', '🙂', '👨🏻‍🦱']

const { sections } = toRefs(props) 
const shouldShowSpeakerAvatars = ref(false)
let avatars: Record<string, string> = {}

watch(sections, (value: TranscriptSection[]) => {
  const languages = new Set<string>()
  value.forEach((section) => {
    section.blocks.forEach((block) => {
      languages.add(block.speaker)
    })
  }) 
  const l = Array.from(languages)
  shouldShowSpeakerAvatars.value = l.length > 1
  avatars = createLanguageSpeakerMapping(l, speakers)
}, { immediate: true })


/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function createLanguageSpeakerMapping(
  languages: string[],
  speakers: string[]
) {
  // Ensure there are enough speakers for languages
  if (languages.length > speakers.length) {
    throw new Error('Not enough speakers for all languages')
  }

  // Shuffle speakers array to randomize
  const shuffledSpeakers = [...speakers].sort(() => Math.random() - 0.5)

  // Create mapping
  const mapping: Record<string, string> = {}
  languages.forEach((language: string, index: number) => {
    mapping[language] = shuffledSpeakers[index]
  })

  return mapping
}
</script>


<style scoped>
.transcript-text {
  text-align: justify;
  text-justify: inter-word;

  hyphens: auto;
  -moz-hyphens: auto;
  /* text-align: justify; */

  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  user-select: text !important;
}

.prompter {
  color: white;
  transition: all 0.5s;
  transform: scale(0.95);
  opacity: .5;
}

.paragraph {
  word-wrap: break-word;
  transform: scale(1.01);
  opacity: 1;
}

.highlight {
  transition: all 0.5s;
  color: #FF6B6B;
}

.avatar {
  opacity: .8;
  font-size: .6rem;
  text-align: right;
  transform: translateY(-100px);
  position: relative;
  top: -2px;
}
</style>