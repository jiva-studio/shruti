<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import LectureCard from "./LectureCard.vue"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useToast } from "@kit/composables"

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

<style scoped>
.track-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  /* Breathing room from the prose paragraph above. The parser strips
     trailing whitespace before a block element, so the gap has to
     come from the widget itself. */
  margin: 10px 0;
}

/* Soft gradient divider between consecutive rows — mirrors the
   VerseCard top/bottom rules (faded edges, soft middle). 1px wide
   line painted via background-image so it stays on element layout
   without needing a pseudo-element. */
.track-list :deep(.lecture-card + .lecture-card),
.add-all-btn {
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.18),
    transparent
  );
  background-position: top;
  background-repeat: no-repeat;
  background-size: 100% 1px;
}

.add-all-btn {
  display: flex;
  align-items: center;
  /* Right-aligned, inline-style link button. Lock min-height so the
     busy-spinner doesn't change the row height. */
  justify-content: flex-end;
  min-height: 32px;
  margin: 0;
  padding: 6px 4px;
  border: none;
  /* No `background` shorthand — would clobber the gradient divider
     painted above on the shared selector. Default transparent fill
     comes for free. */
  background-color: transparent;
  color: var(--ion-color-primary);
  font-weight: 400;
  font-size: 12px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: opacity 120ms ease;
}

.add-all-btn:active:not(:disabled) {
  opacity: 0.6;
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
