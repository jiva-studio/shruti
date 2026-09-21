<script setup lang="ts">
import { toRefs } from "vue"
import TextSelector from "./TextSelector.vue"
import TranscriptGroupBody from "./TranscriptGroupBody.vue"
import type { UiTranscriptBlocksGroup } from "./types.js"
import {
  useTranscriptSelection,
  type TextSelectedPayload,
} from "./composables/useTranscriptSelection.js"

export type TextSelectedEvent = TextSelectedPayload
export interface NoteTappedEvent {
  noteIds: readonly string[]
  event: MouseEvent
}

const props = defineProps<{
  /** Languages whose transcript has more than one speaker — see
   *  `TranscriptBlockRenderer.displaySpeakerIcon`. Evaluated per language so a
   *  monologue stays clean beside a dialogue in the other one. */
  multiSpeakerLanguages: ReadonlySet<string>
  groups: readonly UiTranscriptBlocksGroup[]
  position: number
  duration: number
  shouldHighlightCurrentSentence: boolean
  /** See TranscriptDialog — false suppresses the prompter scaling. */
  enableActiveProminence?: boolean
}>()

const emit = defineEmits<{
  seek: [position: number]
  /** An inline chapter heading was tapped — start playback there + scroll. */
  "chapter-seek": [startMs: number]
  "text-selected": [event: TextSelectedEvent]
  /** Re-emitted from TranscriptBlockRenderer when a highlighted span is tapped. */
  "note-tapped": [event: NoteTappedEvent]
  /** Propagates the long-press-on-selectable signal up to the controller. */
  "pick-start": []
}>()

const { groups, position } = toRefs(props)
const { selectionRange, applySelectionRange, clearSelection, buildSelectedPayload, isActiveGroup } =
  useTranscriptSelection({
    groups,
    position,
  })

// Inline chapter heading tapped — distinct from a block seek: the dialog
// turns this into seek + play + scroll-to-heading.
function onHeadingTap(startMs: number | undefined): void {
  if (startMs !== undefined) emit("chapter-seek", startMs)
}

function onSelecting(start: number, end: number): void {
  applySelectionRange(start, end)
}

function onSelected(start: number, end: number, event: TouchEvent): void {
  const payload = buildSelectedPayload(start, end, event)
  if (payload) emit("text-selected", payload)
  // Empty selection (e.g. dragged across an unselectable verse block) —
  // wipe the highlight immediately, no popover will fire to clear it.
  else clearSelection()
}

// Expose the imperative clear handle so the parent dialog can wipe the
// active selection range after the popover dismisses or an action
// completes — without it the highlight stays stuck on the page.
defineExpose({ clearSelection })
</script>

<template>
  <TextSelector
    :class="['transcript-text', { static: enableActiveProminence === false }]"
    dataset-field-start="data-time-start"
    dataset-field-end="data-time-end"
    @selecting="onSelecting"
    @selected="onSelected"
    @pick-start="emit('pick-start')"
  >
    <template v-for="(group, groupIdx) in groups" :key="groupIdx">
      <h2
        v-if="group.heading"
        class="chapter-heading"
        :data-heading-start="group.headingStartMs"
        @click="onHeadingTap(group.headingStartMs)"
      >
        {{ group.heading }}
      </h2>
      <p :class="{ prompter: true, paragraph: isActiveGroup(group), paired: group.paired }">
        <TranscriptGroupBody
          :group="group"
          :multi-speaker-languages="multiSpeakerLanguages"
          :position="position"
          :duration="duration"
          :should-highlight-current-sentence="shouldHighlightCurrentSentence"
          :enable-active-prominence="enableActiveProminence !== false"
          :selection-range="selectionRange"
          @seek="(pos) => emit('seek', pos)"
          @note-tapped="(payload) => emit('note-tapped', payload)"
        />
      </p>
    </template>
  </TextSelector>
</template>

<style scoped>
.transcript-text {
  text-align: justify;
  text-justify: inter-word;
  hyphens: auto;
  -moz-hyphens: auto;
}

.chapter-heading {
  text-align: center;
  margin: 1.6em 0 0.2em;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.25;
  color: var(--lectorium-immersive-text, #fff);
  cursor: pointer;
}

.prompter {
  color: white;
  transition: all 0.4s;
  transform: scale(0.95);
  opacity: 0.5;
  position: relative;
}

.paragraph {
  word-wrap: break-word;
  transform: scale(1.01);
  opacity: 1;
}

.transcript-text.static .prompter,
.transcript-text.static .paragraph {
  transform: none;
  opacity: 1;
  transition: none;
}

/* Sentence-paired: original on top, translation stacked directly beneath and
   slightly dimmed so the pair reads as one unit. A flex column with a tiny gap
   pins the within-pair spacing exactly (no inherited line-box gap); the space
   BETWEEN pairs (margin-bottom) is deliberately larger. */
.paired {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 0.85em;
}
</style>
