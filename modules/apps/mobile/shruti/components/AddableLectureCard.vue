<template>
  <article class="addable" :class="{ tappable: canAdd }" @click="onCardTap">
    <div class="stage">
      <img v-if="cover" class="cover" :src="cover" :alt="title" loading="lazy" />
      <div v-else class="cover cover--placeholder" aria-hidden="true">
        <IconVinyl :size="40" />
      </div>

      <!-- One corner, four things it can be. The progress badge is the same one
           the library shelf shows, so a lecture being fetched looks the same
           wherever it was started from. -->
      <IngestProgressBadge
        v-if="state === 'pending'"
        class="corner badge"
        :percent="progress?.percent"
        :label="progress?.label ?? ''"
      />
      <button
        v-else-if="state === 'failed'"
        type="button"
        class="corner control control--error"
        :aria-label="retryLabel"
        @click.stop="emit('add')"
      >
        <IconRefresh :size="18" />
      </button>
      <span v-else-if="state === 'busy'" class="corner control" aria-hidden="true">
        <IonSpinner name="crescent" class="spinner" />
      </span>
      <span
        v-else-if="state === 'ready'"
        class="corner control control--done"
        :aria-label="doneLabel"
      >
        <IconCheck :size="20" />
      </span>
      <button
        v-else
        type="button"
        class="corner control"
        :aria-label="addLabel"
        @click.stop="emit('add')"
      >
        <IconPlus :size="20" />
      </button>

      <div class="overlay">
        <span class="title">{{ title }}</span>
        <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconVinyl, IconPlus, IconCheck, IconRefresh } from "@tabler/icons-vue"
import IngestProgressBadge from "./IngestProgressBadge.vue"

/**
 * A lecture we do not have yet, offered as a 16:9 poster with one control.
 *
 * Shared by the two places that offer one: the card chat emits when it finds a
 * lecture, and the carousel of what a search turned up on other archives. They
 * are the same picture and the same gesture, and were briefly two components
 * that had to be kept looking alike by hand.
 *
 * Presentational only. It is told what state it is in and emits `add`; who is
 * allowed to add, what that costs and what happens next belong to whoever is
 * holding it.
 */
export type AddableState = "addable" | "busy" | "pending" | "ready" | "failed"

const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** Poster URL, or nothing — then the placeholder disc. */
    cover?: string | null
    state: AddableState
    /** Stage and completion while ingesting. */
    progress?: { label: string; percent?: number }
    addLabel: string
    retryLabel: string
    doneLabel: string
  }>(),
  { subtitle: "", cover: null, progress: undefined }
)

const emit = defineEmits<{ add: [] }>()

const canAdd = computed(() => props.state === "addable" || props.state === "failed")

// The whole poster is the gesture, not only the corner. There is nothing else
// to open: the recording is not ours until it has been added.
function onCardTap(): void {
  if (canAdd.value) emit("add")
}
</script>

<style scoped>
.addable {
  display: block;
  border-radius: 12px;
  overflow: hidden;
}

.tappable {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.stage {
  position: relative;
  aspect-ratio: 16 / 9;
  line-height: 0;
  background: #000;
}

.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-medium);
}

.corner {
  position: absolute;
  top: 8px;
  right: 8px;
}

.badge {
  max-width: calc(100% - 16px);
}

.control {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.control--done {
  background: var(--ion-color-success, #2dd36f);
  cursor: default;
}

.control--error {
  background: var(--ion-color-danger, #eb445a);
}

.spinner {
  width: 18px;
  height: 18px;
  color: #fff;
}

/* Title and author over a bottom gradient, poster-style. */
.overlay {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 28px 12px 10px;
  line-height: 1.25;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.82) 0%, rgba(0, 0, 0, 0) 100%);
}

.title {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.subtitle {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.82);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
