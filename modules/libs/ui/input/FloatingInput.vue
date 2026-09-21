<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref, useSlots, watch } from "vue"

/**
 * The floating input capsule: a growing one-line field meant to sit over the
 * bottom of a screen, where the thumb already is, with room on its trailing
 * edge for one round control.
 *
 * What that control IS belongs to whoever is using the field — a conversation
 * puts a send button there, a search puts a magnifier that turns into a clear.
 * So it comes in through the `action` slot, which is handed everything it needs
 * to decide: whether there is text, whether a turn is streaming, and the two
 * gestures a field like this has — `submit` and `clear`.
 * `FloatingInputButton` beside this file is the round shell they share, so the
 * two surfaces differ in the glyph and the gesture rather than in the look.
 *
 * The text can be left to the component — `submit` clears it, which is what a
 * conversation wants — or bound with `v-model` by a caller that searches as it
 * is typed. Binding is opt-in, so a caller that never mentions it is unchanged.
 */
const props = defineProps<{
  /** Streaming a turn: the field goes read-only. What the button becomes is
   *  the caller's business — the slot is told. */
  sending?: boolean
  /** Disable the field (e.g. quota lock). Independent of `sending`. */
  disabled?: boolean
  placeholder: string
  composeAriaLabel?: string
}>()

/** Opt-in two-way binding. Undefined leaves the text to the component. */
const model = defineModel<string | undefined>({ default: undefined })

/** Enter, on a field that never takes a newline. */
const emit = defineEmits<{ submit: [text: string] }>()

/**
 * `defineModel` hands back a writable ref whether or not anyone bound it, so
 * its value cannot answer "whose text is this?" — writing a keystroke into an
 * unbound model makes the component look owned from the first character. Ask
 * what was actually passed instead; a binding is either there at mount or not.
 */
const vnodeProps = getCurrentInstance()?.vnode.props ?? {}
const isModelBound = "modelValue" in vnodeProps || "onUpdate:modelValue" in vnodeProps

const text = ref(model.value ?? "")
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const slots = useSlots()

const hasText = computed(() => text.value.trim().length > 0)
const hasAction = computed(() => slots.action !== undefined)

function resize(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${el.scrollHeight}px`
}

watch(text, (next) => {
  if (isModelBound) model.value = next
  void nextTick(resize)
})

// A caller that owns the text can change it under us.
watch(model, (next) => {
  if (next !== undefined && next !== text.value) text.value = next
})

/** Empty the field and keep the caret in it. Handed to the slot. */
function clear(): void {
  text.value = ""
  void nextTick(() => {
    resize()
    textareaRef.value?.focus()
  })
}

/**
 * Hand the text over and, when the field owns it, empty it — a conversation
 * expects the capsule to be blank once the turn is away. A caller holding the
 * text with `v-model` keeps whatever it decides.
 */
function submit(): void {
  if (!hasText.value || props.sending || props.disabled) return
  emit("submit", text.value.trim())
  if (!isModelBound) clear()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
  // An Enter that commits an IME candidate belongs to the composition, not to
  // us; 229 is the keyCode engines report when they don't set the flag.
  if (event.isComposing || event.keyCode === 229) return
  // Never a newline in a one-line capsule; Enter does what the button does.
  event.preventDefault()
  submit()
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

defineExpose({ setText, focus, clear, submit })
</script>

<template>
  <div class="floating-input" :class="{ 'has-action': hasAction }">
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
    <!-- Whatever sits on the trailing edge is the caller's: a conversation
         sends, a search clears. This owns where it goes, not what it is. -->
    <div class="action-slot">
      <slot
        name="action"
        :has-text="hasText"
        :text="text"
        :sending="sending === true"
        :disabled="disabled === true"
        :clear="clear"
        :submit="submit"
      />
    </div>
  </div>
</template>

<style scoped>
.floating-input {
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
}

/* Room for the control, kept whether or not it is showing itself: a button
   that fades in must not shove the text sideways as it arrives. */
.floating-input.has-action {
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

.action-slot {
  position: absolute;
  right: 4px;
  bottom: 4px;
}
</style>
