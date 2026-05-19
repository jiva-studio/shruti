<template>
  <div class="chat-inputbar">
    <div class="input-capsule" :class="{ 'has-text': hasText }">
      <textarea
        ref="textareaRef"
        v-model="text"
        rows="1"
        :placeholder="placeholder"
        :disabled="sending"
        class="input"
        @keydown="onKeydown"
        @input="resize"
        @focus="focused = true"
        @blur="focused = false"
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import { IconArrowUp } from "@tabler/icons-vue"

const props = defineProps<{
  sending: boolean
}>()
const emit = defineEmits<{ send: [text: string] }>()

const { t, tm } = useI18n()

const text = ref("")
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const focused = ref(false)

const hasText = computed(() => text.value.trim().length > 0)
const canSend = computed(() => !props.sending && hasText.value)

/** Pool the placeholder rotates through — pure suggestion list. The
 *  generic "ask a question" string used to live here too, but it's dead
 *  weight: every suggestion is itself a usable question, so showing the
 *  generic prompt just wastes a rotation slot. Keeping this in sync with
 *  the chips means newcomers see the same beginner-friendly questions in
 *  both places. */
const placeholderPool = computed<string[]>(() => {
  const raw = tm("chat.suggestions") as unknown
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string" && x.length > 0)
    : []
})

/** Random start so different sessions don't all open on the same question. */
const placeholderIndex = ref(Math.floor(Math.random() * 1000))
const placeholder = computed<string>(() => {
  const pool = placeholderPool.value
  if (pool.length === 0) return t("chat.placeholder")
  return pool[placeholderIndex.value % pool.length] ?? t("chat.placeholder")
})

let rotationTimer: ReturnType<typeof setTimeout> | null = null

function clearRotation(): void {
  if (rotationTimer !== null) {
    clearTimeout(rotationTimer)
    rotationTimer = null
  }
}

/** Schedule the next placeholder swap. Random 5–7s so the cycle feels
 *  alive rather than metronomic. Paused while the textarea is focused or
 *  already has text — moving the placeholder under the user's caret would
 *  be jarring, and when there's text the placeholder isn't visible anyway. */
function scheduleNextRotation(): void {
  clearRotation()
  if (focused.value || hasText.value) return
  if (placeholderPool.value.length <= 1) return
  const delay = 5000 + Math.floor(Math.random() * 2001)
  rotationTimer = setTimeout(() => {
    placeholderIndex.value = (placeholderIndex.value + 1) % placeholderPool.value.length
    scheduleNextRotation()
  }, delay)
}

watch([focused, hasText], scheduleNextRotation)

onMounted(scheduleNextRotation)
onUnmounted(clearRotation)

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

/** Programmatically fill the input — used by SuggestionChips to seed a
 *  prompt onto the empty composer. Focuses + grows the textarea so the
 *  user can tweak before sending. */
function setText(next: string): void {
  text.value = next
  void nextTick(() => {
    resize()
    textareaRef.value?.focus()
    // Move caret to end so further typing appends.
    const el = textareaRef.value
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  })
}

defineExpose({ setText })
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
  /* Palette tokens — see theme/variables.css :root +
   * @media (prefers-color-scheme: dark). Light theme lifts to white
   * above the cream page; dark theme picks a tone slightly above
   * --ion-card-background. */
  background: var(--lectorium-input-surface);
  border: 1px solid var(--lectorium-input-border);
  border-radius: 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  pointer-events: auto;
  /* Single-line geometry: capsule height matches the 36px send button
   * + 4px padding top/bottom = 44px total. With input.padding 7/7 the
   * one-line text sits flush vertical-center with the button. */
  padding: 4px 4px 4px 0;
  min-height: 44px;
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
  /* Own vertical padding (7/7) — combined with the capsule's 4/4 this
   * makes the one-line scrollHeight = 35px and total capsule height
   * = 35 + 8 ≈ 44px (clamped by min-height). The text sits flush with
   * the 36px send button. */
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
</style>
