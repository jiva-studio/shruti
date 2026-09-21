<script setup lang="ts">
import { IconHistory, IconMessageCirclePlus } from "@tabler/icons-vue"

defineProps<{ title: string; canStartNew: boolean }>()
const emit = defineEmits<{ "open-history": []; "new-session": [] }>()
</script>

<template>
  <div class="chat-fixed-top">
    <div class="chat-top-actions">
      <button
        type="button"
        class="action-btn"
        :aria-label="$t('chat.history')"
        @click="emit('open-history')"
      >
        <IconHistory :size="22" />
      </button>
      <h1 class="chat-title">{{ title }}</h1>
      <!-- A session is born from the first message, so there is nothing to
           start anew from on the welcome screen. The spacer keeps the title
           centred. -->
      <button
        v-if="canStartNew"
        type="button"
        class="action-btn"
        :aria-label="$t('chat.newSession')"
        @click="emit('new-session')"
      >
        <IconMessageCirclePlus :size="22" />
      </button>
      <span v-else class="action-btn" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
/* Opaque cream over the safe area and the button row, then a long eased fade.
 * Unlike SearchView's hard cut, this one sits over scrolling text, which wants
 * to dissolve rather than hit a band. */
.chat-fixed-top {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  z-index: 10;
  padding-top: env(safe-area-inset-top);
  padding-bottom: 28px;
  pointer-events: none;
  background:
    linear-gradient(to bottom, rgba(0, 0, 0, 0.05) 0%, rgba(0, 0, 0, 0) 100%),
    linear-gradient(
      to bottom,
      rgba(var(--lectorium-fade-bg-rgb), 1) 0%,
      rgba(var(--lectorium-fade-bg-rgb), 0.95) 35%,
      rgba(var(--lectorium-fade-bg-rgb), 0.55) 70%,
      rgba(var(--lectorium-fade-bg-rgb), 0) 100%
    );
}

.chat-top-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
}

.chat-top-actions > * {
  pointer-events: auto;
}

.chat-title {
  flex: 1;
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  text-align: center;
  color: var(--ion-text-color);
  /* Room for the 44px buttons on either side, so the title stays centred on
   * the page rather than in the gap. */
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.action-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 0;
  background: transparent;
  color: var(--ion-text-color);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
}

.action-btn:active {
  background: rgba(var(--ion-color-primary-rgb), 0.12);
}
</style>
