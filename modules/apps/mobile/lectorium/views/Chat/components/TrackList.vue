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
import { useAddToPlaylist } from "@lectorium/composables/useAddToPlaylist.js"
import { useToast } from "@lectorium/services/useToast.js"

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
  gap: 0;
}

.add-all-btn {
  margin: 8px 0 0;
  padding: 10px 14px;
  border: none;
  border-radius: 12px;
  background: rgba(var(--ion-color-primary-rgb), 0.14);
  color: var(--ion-color-primary);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease, transform 60ms ease;
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
  height: 18px;
}
</style>
