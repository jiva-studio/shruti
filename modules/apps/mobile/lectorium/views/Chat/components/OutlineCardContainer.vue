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
    :disabled="disabled"
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
  /** Set while the chat quota lockout is open. Passed straight to the card:
   *  a chapter tap dispatches a turn, and `sendMessage` refuses one while
   *  the lock is armed. The lecture header still opens the track. */
  disabled?: boolean
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

function onOpenLecture({ trackId }: { trackId: string; startMs: number }): void {
  // The header opens the lecture from the start — the card emits `startMs: 0`
  // and TrackView has no timecoded entry point (#1895). A chapter tap is a
  // `pick-chapter` recap turn, not a navigation.
  void router.push({ name: "track", params: { trackId } })
}

onMounted(loadTitle)
watch(() => props.trackId, loadTitle)
</script>
