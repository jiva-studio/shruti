<template>
  <component
    :is="href ? 'a' : 'button'"
    :type="href ? undefined : 'button'"
    :href="href"
    class="block w-full rounded-xl px-4 py-3.5 text-left"
    :class="selected ? 'bg-cream-deep' : ''"
    @click="onClick"
  >
    <h3 class="text-lg font-semibold leading-snug text-ink">{{ title }}</h3>
    <p v-if="meta" class="mt-1.5 text-sm text-medium">{{ meta }}</p>
    <div v-if="refs.length" class="mt-3 flex flex-wrap gap-1.5">
      <span
        v-for="(r, j) in refs"
        :key="j"
        class="rounded-md bg-surface px-2 py-0.5 text-xs font-medium text-coffee"
      >
        {{ r }}
      </span>
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { LectureIndexEntry } from '@lib/catalog/types.js'
import type { Lang } from '../../i18n/ui'
import { lectureTitle, lectureMeta, lectureRefs } from '../../lib/lectureDisplay'

const props = defineProps<{
  entry: LectureIndexEntry
  lang: Lang
  /** When set, the row is a link; otherwise it is a select button. */
  href?: string
  selected?: boolean
}>()
const emit = defineEmits<{ (e: 'select'): void }>()

const title = computed(() => lectureTitle(props.entry, props.lang))
const meta = computed(() => lectureMeta(props.entry, props.lang))
const refs = computed(() => lectureRefs(props.entry, props.lang))

function onClick() {
  if (!props.href) emit('select')
}
</script>
