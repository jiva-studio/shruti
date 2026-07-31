<template>
  <article v-if="payload" class="add-card">
    <div class="stage">
      <img
        v-if="payload.thumbnail"
        class="cover"
        :src="payload.thumbnail"
        :alt="payload.title"
        loading="lazy"
      />
      <div v-else class="cover cover--placeholder" aria-hidden="true">
        <IconVinyl :size="40" />
      </div>

      <!-- Live ingest progress pill (stage + download percent) while the lecture
           ingests — takes over the corner control so the user watches it advance
           without leaving chat. -->
      <span
        v-if="liveStatus?.kind === 'pending'"
        class="stage-pill"
        role="status"
        :aria-label="liveStatus.label"
      >
        <IonSpinner name="crescent" class="spinner" />
        {{ liveStatus.label }}
      </span>
      <button
        v-else-if="liveStatus?.kind === 'failed' || state === 'error'"
        class="add-btn add-btn--error"
        :aria-label="$t('chat.actionRetry')"
        @click="emit('confirm', actionId)"
      >
        <IconRefresh :size="18" />
      </button>

      <!-- Compact add control, top-right over the cover. -->
      <button
        v-else-if="state === 'pending' && !alreadyInLibrary"
        class="add-btn"
        :aria-label="$t('chat.actionAddToLibraryConfirm')"
        @click="emit('confirm', actionId)"
      >
        <IconPlus :size="20" />
      </button>
      <span v-else-if="state === 'executing'" class="add-btn add-btn--busy" aria-hidden="true">
        <IonSpinner name="crescent" class="spinner" />
      </span>
      <span
        v-else
        class="add-btn add-btn--done"
        :aria-label="alreadyInLibrary ? $t('search.actions.alreadyInLibrary') : undefined"
      >
        <IconCheck :size="20" />
      </span>

      <div class="overlay">
        <span class="title">{{ payload.title }}</span>
        <span v-if="payload.author" class="author">{{ payload.author }}</span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"
import { IconVinyl, IconPlus, IconCheck, IconRefresh } from "@tabler/icons-vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

/**
 * Candidate card for an external lecture the chat found (personal library,
 * epic #1236). Laid out like the media (video) card: a 16:9 cover with the
 * title + author overlaid at the bottom and a compact add control in the
 * top-right corner. Tapping it runs the `add_to_library` action, which
 * PRO-gates and triggers ingest of the external lecture. Presentational — the
 * store owns the side effect.
 */
defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "add_to_library" }>
  state: ActionState
  /** The user already has this lecture — show it as in-library, not addable. */
  alreadyInLibrary?: boolean
  /** Live ingest status of the matching library item (from the status poll),
   *  driving the inline progress pill / retry. Undefined once ready or unadded. */
  liveStatus?: { kind: "pending" | "failed"; label: string }
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()
</script>

<style scoped>
.add-card {
  display: block;
  margin: 10px 0;
  border-radius: 4px;
  overflow: hidden;
}

/* 16:9 cover stage — same proportion as the video media card. */
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

/* Compact circular add control, top-right (mirrors the media card's overlay
 * chrome — semi-transparent so it sits cleanly over any cover). */
.add-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.add-btn--done {
  background: var(--ion-color-success, #2dd36f);
}

.add-btn--busy,
.add-btn--error {
  cursor: default;
}

/* Live-progress pill: same top-right corner as the add control, widened to hold
   the stage label + percent. Mirrors the library card's "Downloading" badge. */
.stage-pill {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 16px);
  padding: 6px 12px;
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.spinner {
  width: 18px;
  height: 18px;
  color: #fff;
}

/* Title + author over a bottom gradient, YouTube-poster style. */
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

.author {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.82);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
