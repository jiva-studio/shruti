<template>
  <AddableLectureCard
    :title="title"
    :subtitle="subtitle"
    :cover="cover"
    :state="add.state.value === 'pending' ? 'pending' : add.state.value"
    :progress="{ label: add.stageLabel.value, percent: add.percent.value }"
    :add-label="$t('search.web.add')"
    :retry-label="$t('library.status.retry')"
    :done-label="$t('search.actions.alreadyInLibrary')"
    @add="onAdd"
  />
</template>

<script setup lang="ts">
import { computed } from "vue"
import AddableLectureCard from "@shruti/components/AddableLectureCard.vue"
import type { DiscoveryHit } from "@lib/contracts"
import { useWebLectureAdd } from "../composables/useWebLectureAdd.js"

/**
 * A lecture found on YouTube, as a poster card in the carousel — the same
 * `AddableLectureCard` chat shows for a candidate it found, so the two read as
 * one kind of thing.
 *
 * The adapter is thinner here than chat's: the state comes from the library
 * store keyed by the media URL, rather than from an action lifecycle.
 */
const props = defineProps<{ hit: DiscoveryHit; cover: string }>()

const add = useWebLectureAdd(() => props.hit)

const title = computed(() => props.hit.title || props.hit.media_url)

const subtitle = computed(() =>
  [props.hit.author, props.hit.recorded_on?.slice(0, 4)].filter(Boolean).join(" · ")
)

function onAdd(): void {
  void add.add()
}
</script>
