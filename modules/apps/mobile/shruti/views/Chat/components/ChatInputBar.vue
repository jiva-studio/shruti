<template>
  <div class="chat-inputbar">
    <div class="input-capsule" :class="{ 'has-text': hasText }">
      <textarea
        ref="textareaRef"
        v-model="text"
        rows="1"
        :placeholder="$t('chat.placeholder')"
        :disabled="sending"
        class="input"
        @keydown="onKeydown"
        @input="resize"
      />
      <button
        type="button"
        class="send"
        :class="{ visible: canSend || sending }"
        :aria-label="$t('chat.send')"
        :disabled="!canSend && !sending"
        :tabindex="canSend ? 0 : -1"
        @click="onSendClick"
      >
        <IconArrowUp v-if="!sending" :size="20" stroke="2.5" />
        <IonSpinner v-else name="dots" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconArrowUp } from "@tabler/icons-vue"

const props = defineProps<{
  sending: boolean
}>()
const emit = defineEmits<{ send: [text: string] }>()

const text = ref("")
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const hasText = computed(() => text.value.trim().length > 0)
const canSend = computed(() => !props.sending && hasText.value)

function resize(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight}px`
}

watch(text, () => {
  void nextTick(resize)
})

function onSendClick(): void {
  if (!canSend.value) return
  const payload = text.value.trim()
  text.value = ""
  emit("send", payload)
}

function onKeydown(event: KeyboardEvent): void {
  // Enter without modifiers sends; Shift+Enter / Alt+Enter insert a
  // newline. On native mobile the on-screen "Send" key triggers a plain
  // Enter, mirroring Telegram / Claude.
  if (event.key !== "Enter") return
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
  event.preventDefault()
  if (canSend.value) onSendClick()
}
</script>

<style scoped>
.chat-inputbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* The chat sits inside IonTabs whose tab bar already absorbs the
   * device safe-area-inset-bottom — adding it here on top of that
   * pushed the capsule visibly above the tab bar. Just a small fixed
   * gap is what we want. */
  padding: 8px 12px 8px;
  background: transparent;
  pointer-events: none;
  z-index: 10;
}

.input-capsule {
  position: relative;
  display: flex;
  align-items: flex-end;
  /* Theme-aware surface — cream in light, espresso in dark.
   * Was hardcoded #ffffff which made the capsule a stark white slab in
   * dark mode and washed out the typed text. */
  background: var(--ion-card-background);
  border: 1px solid var(--ion-color-step-200);
  border-radius: 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  pointer-events: auto;
  padding: 14px 4px 14px 0;
  min-height: 49px;
  transition: padding-right 180ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

.input-capsule.has-text {
  padding-right: 44px;
}

.input {
  flex: 1;
  margin: 0;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--ion-text-color);
  font: inherit;
  font-size: 15px;
  line-height: 21px;
  padding: 0 8px 0 16px;
  max-height: 126px;
  overflow-y: auto;
  scrollbar-width: none;
  caret-color: var(--ion-color-primary);
}

.input::-webkit-scrollbar {
  display: none;
}

.input::placeholder {
  color: var(--ion-color-step-500, #8a8a8a);
  opacity: 1;
}

.send {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 0;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transform: scale(0.5);
  opacity: 0;
  pointer-events: none;
  transition:
    transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 140ms ease-out;
  -webkit-tap-highlight-color: transparent;
}

.send.visible {
  transform: scale(1);
  opacity: 1;
  pointer-events: auto;
}

.send:disabled {
  cursor: not-allowed;
}

.send:active:not(:disabled) {
  opacity: 0.75;
}
</style>
