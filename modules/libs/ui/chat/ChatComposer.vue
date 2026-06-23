<template>
  <div class="composer" :class="{ 'has-text': hasText }">
    <textarea
      ref="textareaRef"
      v-model="text"
      rows="1"
      :placeholder="placeholder"
      :aria-label="composeAriaLabel ?? placeholder"
      :disabled="sending || disabled"
      class="input"
      @keydown="onKeydown"
      @input="resize"
    />
    <button
      type="button"
      class="send"
      :class="{ visible: canSend || sending }"
      :aria-label="sendAriaLabel ?? placeholder"
      :disabled="(!canSend && !sending) || disabled"
      :tabindex="(canSend || sending) && !disabled ? 0 : -1"
      @click="onSendClick"
    >
      <span v-if="sending" class="send-spinner"><slot name="spinner" /></span>
      <svg
        v-else
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
  /** Streaming a turn — swaps the send glyph for the `#spinner` slot and
   *  turns the button into a Stop affordance (click emits `cancel`). */
  sending?: boolean
  /** Disable input + send (e.g. quota lock). Independent of `sending`. */
  disabled?: boolean
  placeholder: string
  sendAriaLabel?: string
  composeAriaLabel?: string
}>()

const emit = defineEmits<{ send: [text: string]; cancel: [] }>()

const text = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const hasText = computed(() => text.value.trim().length > 0)
const canSend = computed(() => !props.sending && hasText.value && !props.disabled)

function resize(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

watch(text, () => {
  void nextTick(resize)
})

function onSendClick(): void {
  if (props.sending && !props.disabled) {
    emit('cancel')
    return
  }
  if (!canSend.value) return
  const payload = text.value.trim()
  text.value = ''
  emit('send', payload)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
  event.preventDefault()
  if (canSend.value) onSendClick()
}

function setText(next: string): void {
  text.value = next
  void nextTick(() => {
    resize()
    textareaRef.value?.focus()
    const el = textareaRef.value
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  })
}

function focus(): void {
  void nextTick(() => {
    textareaRef.value?.focus()
  })
}

defineExpose({ setText, focus })
</script>

<style scoped>
.composer {
  position: relative;
  display: flex;
  align-items: flex-end;
  background: var(--lectorium-input-surface);
  border: 1px solid var(--lectorium-input-border);
  border-radius: 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  pointer-events: auto;
  padding: 4px 4px 4px 0;
  min-height: 44px;
  transition: padding-right 180ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

.composer.has-text {
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
  padding: 7px 8px 7px 16px;
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

.send-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}
.send-spinner :deep(*) {
  width: 100%;
  height: 100%;
}
</style>
