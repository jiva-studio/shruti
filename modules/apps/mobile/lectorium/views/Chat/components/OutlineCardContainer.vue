<template>
  <!--
    Host container for the pure OutlineCard. Owns the per-track title load
    (getById + content-language resolution) the card used to run internally,
    and the lecture navigation. The card stays presentational.
  -->
  <OutlineCard
    :track-id="trackId"
    :items="items"
    :track-title="trackTitle"
    @pick-chapter="emit('pick-chapter', $event)"
    @open-lecture="onOpenLecture"
  >
    <template #more="{ n }">{{ $t("chat.outlineMore", { n }) }}</template>
  </OutlineCard>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue"
import router from "@lectorium/router/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { preferredContentLanguage, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import type { TrackId } from "@lib/domain/core.js"
import OutlineCard from "@lib/ui/chat/OutlineCard.vue"

interface OutlineItem {
  readonly startMs: number
  readonly title: string
}

const props = defineProps<{
  trackId: string
  items: readonly OutlineItem[]
}>()

const emit = defineEmits<{
  "pick-chapter": [
    args: {
      trackId: string
      item: OutlineItem
      nextItem: OutlineItem | null
    },
  ]
}>()

// Singleton import — see NotesView.controller for the why.
const app = useLectorium()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()

const trackTitle = ref<string>("")

async function loadTitle(): Promise<void> {
  try {
    const t = await app.repositories().tracks.getById(props.trackId as TrackId)
    if (t) {
      const contentLang = preferredContentLanguage(t, libraryLanguages.value, appLanguage.value)
      trackTitle.value = resolveTrackTitle(t, contentLang ?? appLanguage.value) ?? ""
    }
  } catch {
    /* keep empty — header still renders the "Оглавление" label */
  }
}

function onOpenLecture({ trackId, startMs }: { trackId: string; startMs: number }): void {
  // TrackView already handles `resumeFromMs` query — used by CitationChip.
  void router.push({
    name: "track",
    params: { trackId },
    query: startMs > 0 ? { resumeFromMs: String(startMs) } : undefined,
  })
}

onMounted(loadTitle)
watch(() => props.trackId, loadTitle)
</script>
