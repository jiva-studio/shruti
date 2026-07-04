<script setup lang="ts">
import { computed, ref, watch } from 'vue'
// REAL reused app code — same plain-Markdown export the mobile copy uses.
import { messageToMarkdown } from '@lib/chat/chatMarkers.js'
import { useWebAuth } from '../../composables/useWebAuth'
import type { Msg } from '../../composables/useChatStream'

const props = defineProps<{
  /** The completed assistant message (streaming === false). */
  msg: Msg
  /** Content language (ru|en) — picks verse translations for the export. */
  lang: 'ru' | 'en'
  /** Chat API base for the feedback POST. */
  chatBase: string
}>()

const auth = useWebAuth()

// Feedback categories — wire format mirrors the server's `FeedbackCategory`
// enum; keep in sync with the backend + the mobile FeedbackSheet.
const CATEGORY_OPTIONS = [
  'off_topic',
  'no_results',
  'bad_citations',
  'wrong_language',
  'factually_wrong',
  'other',
] as const
type FeedbackCategory = (typeof CATEGORY_OPTIONS)[number]

// Content language is always ru|en here, so a tiny inline map mirrors the
// mobile i18n (chat.feedback.*) without adding new locale keys.
const L = computed(() =>
  props.lang === 'ru'
    ? {
        copy: 'Копировать',
        copied: 'Скопировано',
        up: 'Хороший ответ',
        down: 'Плохой ответ',
        cancel: 'Отмена',
        sheetTitle: 'Что было не так?',
        sheetHint: 'Все поля необязательные. Нажмите «Отправить», когда готово.',
        categoryLabel: 'Тип',
        categoryPlaceholder: 'Выберите (необязательно)',
        commentLabel: 'Комментарий',
        commentPlaceholder: 'Что-нибудь ещё? (необязательно)',
        submit: 'Отправить',
        categories: {
          off_topic: 'Не по теме',
          no_results: 'Ничего не найдено',
          bad_citations: 'Плохие цитаты',
          wrong_language: 'Не тот язык',
          factually_wrong: 'Фактические ошибки',
          other: 'Другое',
        } as Record<FeedbackCategory, string>,
      }
    : {
        copy: 'Copy',
        copied: 'Copied',
        up: 'Good answer',
        down: 'Bad answer',
        cancel: 'Cancel',
        sheetTitle: 'What was wrong?',
        sheetHint: 'All fields are optional. Tap Submit to send.',
        categoryLabel: 'Type',
        categoryPlaceholder: 'Pick one (optional)',
        commentLabel: 'Comment',
        commentPlaceholder: 'Anything else? (optional)',
        submit: 'Submit',
        categories: {
          off_topic: 'Off-topic',
          no_results: 'Nothing found',
          bad_citations: 'Bad citations',
          wrong_language: 'Wrong language',
          factually_wrong: 'Factually wrong',
          other: 'Other',
        } as Record<FeedbackCategory, string>,
      },
)

// Clean Markdown of the message: widgets stripped, verses/cites/commentaries
// expanded from the message's own payload maps (the web mirror of
// useChatExportMarkdown).
const markdown = computed<string>(() => {
  const m = props.msg
  if (!m.text || m.streaming) return ''
  return messageToMarkdown(m.text, {
    lang: props.lang,
    verseLookup: (sourceId, tokens) => m.verses?.get(`${sourceId}|${tokens}`) ?? null,
    citeLookup: (trackId, startMs, endMs) => {
      const e = m.cites?.get(`${trackId}|${startMs}-${endMs}`)
      if (!e) return null
      return { text: e.text, trackTitle: e.trackTitle, authorName: e.authorName, trackDate: e.trackDate }
    },
    commentaryLookup: (ref) => {
      const e = m.commentaries?.get(String(ref))
      if (!e) return null
      return { text: e.text, authorName: e.authorName, addrLabel: e.addrLabel }
    },
  })
})

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function onCopy(): Promise<void> {
  const md = markdown.value.trim()
  if (!md) return
  try {
    await navigator.clipboard.writeText(md)
  } catch {
    return
  }
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1600)
}

// Feedback → POST /chat/feedback with the turn's trace id (mirrors the mobile
// thumbs). Thumbs-up submits immediately; thumbs-down opens the sheet so the
// user can pick a reason + leave a comment.
const feedback = ref<'up' | 'down' | null>(null)
const sending = ref(false)

const sheetOpen = ref(false)
const category = ref<FeedbackCategory | ''>('')
const comment = ref('')

// Reset the form each fresh open so a previous entry doesn't ghost the next.
watch(sheetOpen, (next, prev) => {
  if (next && !prev) {
    category.value = ''
    comment.value = ''
  }
})

// Best-effort — with no trace id (a legacy chat restored from storage before
// trace ids were persisted) there's nothing to score, so we keep the local
// selection but skip the network. Fresh + restored turns carry a trace id.
async function postFeedback(body: Record<string, unknown>): Promise<boolean> {
  const traceId = props.msg.traceId
  if (!traceId) return true
  const jwt = await auth.ensureToken()
  const res = await fetch(`${props.chatBase}/chat/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ ...body, trace_id: traceId }),
  })
  return res.ok
}

async function onThumbUp(): Promise<void> {
  if (sending.value) return
  const prev = feedback.value
  feedback.value = 'up' // optimistic — revert on failure
  sending.value = true
  try {
    if (!(await postFeedback({ value: 'up' }))) throw new Error('failed')
  } catch {
    feedback.value = prev
  } finally {
    sending.value = false
  }
}

function onThumbDown(): void {
  if (sending.value) return
  sheetOpen.value = true
}

async function onSheetSubmit(): Promise<void> {
  if (sending.value) return
  const prev = feedback.value
  feedback.value = 'down' // optimistic
  sending.value = true
  sheetOpen.value = false
  try {
    const body: Record<string, unknown> = { value: 'down' }
    if (category.value) body.category = category.value
    const c = comment.value.trim()
    if (c) body.comment = c.slice(0, 500)
    if (!(await postFeedback(body))) throw new Error('failed')
  } catch {
    feedback.value = prev
  } finally {
    sending.value = false
  }
}

function onSheetCancel(): void {
  sheetOpen.value = false
}
</script>

<template>
  <div v-if="markdown" class="mt-1.5 -ml-1.5 flex items-center gap-0.5">
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-medium opacity-60 transition hover:opacity-100"
      :class="{ 'text-saffron opacity-100': copied }"
      :aria-label="copied ? L.copied : L.copy"
      @click="onCopy"
    >
      <svg v-if="copied" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 12l5 5L20 7" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
      </svg>
    </button>

    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-medium opacity-60 transition hover:opacity-100"
      :class="{ 'text-saffron opacity-100': feedback === 'up' }"
      :aria-label="L.up"
      @click="onThumbUp"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 10v11" />
        <path d="M7 10l4-7a2 2 0 0 1 2.6 2.4L13 9h5.2a2 2 0 0 1 2 2.4l-1.4 7a2 2 0 0 1-2 1.6H7" />
      </svg>
    </button>
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-medium opacity-60 transition hover:opacity-100"
      :class="{ 'text-saffron opacity-100': feedback === 'down' }"
      :aria-label="L.down"
      @click="onThumbDown"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17 14V3" />
        <path d="M17 14l-4 7a2 2 0 0 1-2.6-2.4L11 15H5.8a2 2 0 0 1-2-2.4l1.4-7a2 2 0 0 1 2-1.6H17" />
      </svg>
    </button>
  </div>

  <!-- Feedback dialog (thumbs-down), the web mirror of the app's FeedbackSheet. -->
  <Teleport to="body">
    <div
      v-if="sheetOpen"
      class="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4"
      @click.self="onSheetCancel"
    >
      <div class="w-full max-w-md rounded-t-2xl bg-cream p-5 shadow-xl sm:rounded-2xl">
        <h2 class="font-serif text-lg font-bold text-ink">{{ L.sheetTitle }}</h2>
        <p class="mt-1 text-sm text-medium">{{ L.sheetHint }}</p>

        <label class="mt-4 block text-xs font-semibold uppercase tracking-wide text-medium">{{ L.categoryLabel }}</label>
        <select
          v-model="category"
          class="mt-1 w-full rounded-lg border border-line bg-cream px-3 py-2.5 text-sm text-ink outline-none focus:border-saffron"
        >
          <option value="">{{ L.categoryPlaceholder }}</option>
          <option v-for="opt in CATEGORY_OPTIONS" :key="opt" :value="opt">{{ L.categories[opt] }}</option>
        </select>

        <label class="mt-4 block text-xs font-semibold uppercase tracking-wide text-medium">{{ L.commentLabel }}</label>
        <textarea
          v-model="comment"
          rows="3"
          maxlength="500"
          :placeholder="L.commentPlaceholder"
          class="mt-1 w-full resize-none rounded-lg border border-line bg-cream px-3 py-2.5 text-sm text-ink outline-none focus:border-saffron"
        />
        <p class="mt-1 text-right text-xs text-medium">{{ comment.length }}/500</p>

        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft transition hover:bg-cream-deep/60"
            @click="onSheetCancel"
          >{{ L.cancel }}</button>
          <button
            type="button"
            class="rounded-lg bg-saffron px-5 py-2 text-sm font-semibold text-cream transition hover:bg-saffron-shade disabled:opacity-60"
            :disabled="sending"
            @click="onSheetSubmit"
          >{{ L.submit }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
