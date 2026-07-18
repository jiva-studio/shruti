<template>
  <ActionCardShell
    :show="!!payload"
    :state="state"
    dense
    :title="$t('chat.actionAddToLibraryTitle')"
    :confirm-label="$t('chat.actionAddToLibraryConfirm')"
    :done-label="$t('chat.actionAddToLibraryDone')"
    :error-label="$t('chat.actionAddToLibraryError')"
    @confirm="emit('confirm', actionId)"
  >
    <div v-if="payload" class="candidate">
      <div class="thumb">
        <img
          v-if="payload.thumbnail"
          :src="payload.thumbnail"
          :alt="payload.title"
          loading="lazy"
        />
        <div v-else class="thumb-placeholder" aria-hidden="true">
          <IconVinyl :size="20" />
        </div>
      </div>
      <div class="info">
        <span class="title">{{ payload.title }}</span>
        <span v-if="payload.author" class="author">{{ payload.author }}</span>
      </div>
    </div>
  </ActionCardShell>
</template>

<script setup lang="ts">
import { IconVinyl } from "@tabler/icons-vue"
import ActionCardShell from "./ActionCardShell.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

/**
 * Candidate card for an external lecture the chat found (personal library,
 * epic #1236). Shows the thumbnail + title + author; tapping "Add" runs the
 * `add_to_library` action, which PRO-gates and triggers the ingest client→
 * server call. Presentational — the store owns the side effect.
 */
defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "add_to_library" }>
  state: ActionState
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()
</script>

<style scoped>
.candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.thumb {
  flex: 0 0 auto;
  width: 56px;
  height: 42px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--ion-color-light, #f4f5f8);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ion-color-medium, #92949c);
}

.info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ion-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.author {
  font-size: 12px;
  color: var(--ion-color-medium, #92949c);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
