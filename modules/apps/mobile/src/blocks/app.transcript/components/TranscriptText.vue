<template>
  <TextSelector
    class="transcript-text"
    dataset-field-start="data-time-start"
    dataset-field-end="data-time-end"
    @selecting="onSelecting"
    @selected="onSelected"
  >
    <p
      v-for="(section, idx) in blockGroups"
      :key="idx"
      :class="{
        'prompter': true,
        'paragraph': section.blocks[0]?.block.start <= position && section.blocks[section.blocks.length-1].block.end >= position
      }"
    >
      <Timestamp
        v-if="section.blocks[0]?.block.start && section.blocks[0].block.type !== 'verse:text'"
        :start="section.blocks[0]?.block.start"
        :duration="duration"
      />
      <template
        v-for="block, blockIdx in section.blocks"
        :key="blockIdx"
      >
        <SentenceBlock
          v-if="block.block.type === 'sentence'"
          :text="block.block.text"
          :icon="showSpeakerIcons ? block.icon : undefined"
          :reference="block.block.reference"
          :reference-visible="block.block.start <= position+1 && block.block.end >= position - 1"
          :lang="block.language"
          :class="{
            'current': highlightCurrentSentence && block.block.start <= position && block.block.end >= position,
            'highlighted': block.bookmarked,
            'selected': block.selected,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          @click="emit('seek', block.block.start + .01)"
        />

        <VerseTextBlock
          v-if="block.block.type === 'verse:text' && block.block.text.length > 1"
          :lines="block.block.text"
          :reference="block.block.reference"
          :class="{
            'current': highlightCurrentSentence && block.block.start <= position && block.block.end >= position,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          @click="emit('seek', block.block.start + .01)"
        />
        
        <VerseTextInlineBlock
          v-if="block.block.type === 'verse:text' && block.block.text.length <= 1"
          :text="block.block.text[0]"
          :reference="block.block.reference"
          :reference-visible="block.block.start <= position+1 && block.block.end >= position - 1"
          :class="{
            'current': highlightCurrentSentence && block.block.start <= position && block.block.end >= position,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          @click="emit('seek', block.block.start + .01)"
        />

        <VerseTranslationBlock
          v-if="block.block.type === 'verse:translation'"
          :text="block.block.text"
          :class="{
            'current': highlightCurrentSentence && block.block.start <= position && block.block.end >= position,
            'highlighted': block.bookmarked,
            'selected': block.selected,
          }"
          :data-time-start="block.block.start"
          :data-time-end="block.block.end"
          @click="emit('seek', block.block.start + .01)"
        />
      </template>
    </p>
  </TextSelector>
</template>

<script setup lang="ts">
import Timestamp from './Timestamp.vue'
import TextSelector from './TextSelector.vue'
import { SentenceBlock, VerseTextBlock, VerseTextInlineBlock, VerseTranslationBlock } from '@blocks/app.transcript'
import { TranscriptBlocksGroupView } from '../models'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type TextSelectedEvent = {
  text: string
  timeStart: number
  timeEnd: number
  event: TouchEvent
}

const props = defineProps<{
  showSpeakerIcons: boolean
  blockGroups: TranscriptBlocksGroupView[]
  position: number
  duration: number
  highlightCurrentSentence: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  textSelected: [event: TextSelectedEvent]
}>()


/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelecting(
  start: number, 
  end: number
) {
  // remove selection
  props.blockGroups
    .flatMap(x => x.blocks)
    .forEach(x => x.selected = false)
  
  // add selection
  props.blockGroups
    .flatMap(x => x.blocks)
    .filter(x => x.block.start >= start && x.block.end <= end)
    .forEach(x => x.selected = true)
}

function onSelected(
  start: number,
  end: number,
  event: TouchEvent
) {
  const selectableBlocks = ['sentence', 'verse:translation']
  const selectedText = props.blockGroups
    .flatMap(x => x.blocks)
    .filter(x => x.block.start >= start && x.block.end <= end)
    .filter(x => selectableBlocks.includes(x.block.type))
    // @ts-ignore
    .map(x => x.block.text || '')
    .join(' ')

  
  if (selectedText) {
    emit('textSelected', { text: selectedText, timeStart: start, timeEnd: end, event })
  }
}
</script>


<style scoped>
.transcript-text {
  text-align: justify;
  text-justify: inter-word;
  hyphens: auto;
  -moz-hyphens: auto;
}

span {
  transition: all .4s ease-in-out;
}

.prompter {
  color: white;
  transition: all 0.4s;
  transform: scale(0.95);
  opacity: .5;
  position: relative;
}

.paragraph {
  word-wrap: break-word;
  transform: scale(1.01);
  opacity: 1;
}

.current {
  transition: all 0.4s;
  color: #FF6B6B !important;
}

.highlighted {
  color: #C77DFF;
}

.selected {
  color: #FFFFFF !important;
  background-color: #9D4EDD;
}
</style>