<template>
  <section class="track-list" :class="{ multi: trackIds.length > 1 }">
    <LectureCard
      v-for="(trackId, idx) in trackIds"
      :key="`${trackId}-${idx}`"
      :track-id="trackId"
    />
    <button
      v-if="trackIds.length > 1"
      type="button"
      class="add-all-btn"
      :disabled="busy"
      @click="onAddAll"
    >
      <IonSpinner v-if="busy" name="dots" class="spinner" />
      <span v-else>{{ $t("chat.trackListAddAllToPlaylist") }}</span>
    </button>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import LectureCard from "./LectureCard.vue"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useToast } from "@shruti/services/useToast.js"

const props = defineProps<{ trackIds: readonly string[] }>()

const { t } = useI18n()
const { addToPlaylist } = useAddToPlaylist()
const toast = useToast()

const busy = ref(false)

async function onAddAll(): Promise<void> {
  if (busy.value) return
  busy.value = true
  let added = 0
  let failed = 0
  // Sequential adds — `playlist.add` is idempotent on duplicates, so
  // we don't dedupe up-front; the store handles "already in playlist"
  // as a no-op. Parallel calls would race the persistence layer.
  for (const trackId of props.trackIds) {
    try {
      await addToPlaylist(trackId)
      added += 1
    } catch (err) {
      console.warn("[track-list] add to playlist failed", { trackId, err })
      failed += 1
    }
  }
  busy.value = false
  if (added > 0 && failed === 0) {
    await toast.info(t("chat.trackListAddAllDone", { n: added }))
  } else if (added > 0) {
    await toast.info(t("chat.trackListAddAllPartial", { added, failed }))
  } else {
    await toast.error(t("chat.trackListAddAllFailed"))
  }
}
</script>

<style scoped>
.track-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* Breathing room from the prose paragraph above. The parser strips
     trailing whitespace before a block element, so the gap has to
     come from the widget itself. */
  margin-top: 10px;
}

/* Inside a track list the cards stack tightly — override LectureCard's
   own 10px vertical margin (designed for standalone use) so the
   stack doesn't look airy. */
.track-list :deep(.lecture-card) {
  margin: 0;
}

.add-all-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  /* Lock the height so the busy-spinner doesn't make the button taller
     than its idle text state — the dots-spinner has a different
     intrinsic height than the body text. */
  min-height: 40px;
  /* No own top margin — the flex container's `gap` already spaces the
     button from the last card (same 6px as inter-card gap). */
  padding: 10px 14px;
  border: none;
  border-radius: 12px;
  background: rgba(var(--ion-color-primary-rgb), 0.14);
  color: var(--ion-color-primary);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    background 120ms ease,
    transform 60ms ease;
}

.add-all-btn:active:not(:disabled) {
  background: rgba(var(--ion-color-primary-rgb), 0.2);
  transform: scale(0.998);
}

.add-all-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.spinner {
  --color: var(--ion-color-primary);
  /* Match the line-height of the body text so the button's content box
     stays the same size as in the idle state. */
  height: 20px;
  width: 28px;
}
</style>
