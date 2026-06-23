<script setup lang="ts">
import { ref, nextTick, computed } from 'vue'
import { STORE } from '../../i18n/ui'
import ChatMessageBody from './ChatMessageBody.vue'
// REAL reused component (decoupled: status label via prop, spinner via slot).
import StatusPill from '@lib/ui/chat/StatusPill.vue'
import ChatComposer from '@lib/ui/chat/ChatComposer.vue'
import { webLocale } from '../../lib/i18n'

type Lang = 'ru' | 'en'
const props = defineProps<{ lang: Lang; trackId?: string; bare?: boolean }>()
webLocale.value = props.lang

const AUTH = (import.meta.env.PUBLIC_AUTH_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const CHAT = (import.meta.env.PUBLIC_CHAT_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const FREE_TURNS = 10

const L = {
  ru: {
    title: 'Спросить Садху',
    sub: 'Анонимно, без регистрации. Спросите о душе, карме или смысле жизни.',
    placeholder: props.trackId ? 'Спросите об этой лекции…' : 'Напишите вопрос…',
    send: 'Спросить',
    stop: 'Стоп',
    left: (n: number) => `Осталось вопросов: ${n}`,
    capTitle: 'Продолжите в приложении',
    capBody: 'Установите «Слушай Садху», чтобы спрашивать без ограничений и слушать лекции целиком.',
    errTitle: 'Чат пока недоступен здесь',
    errBody: 'Полная версия ассистента — в приложении. Установите «Слушай Садху» и спрашивайте без ограничений.',
    suggestions: ['Что такое душа?', 'Зачем нужна карма?', 'В чём смысл жизни?'],
  },
  en: {
    title: 'Ask Sadhu',
    sub: 'Anonymous, no sign-up. Ask about the soul, karma or the meaning of life.',
    placeholder: props.trackId ? 'Ask about this lecture…' : 'Type your question…',
    send: 'Ask',
    stop: 'Stop',
    left: (n: number) => `Questions left: ${n}`,
    capTitle: 'Continue in the app',
    capBody: 'Install Shruti to ask without limits and hear the full lectures.',
    errTitle: 'Chat is not available here yet',
    errBody: 'The full assistant lives in the app. Install Shruti and ask without limits.',
    suggestions: ['What is the soul?', 'Why does karma matter?', 'What is the meaning of life?'],
  },
}[props.lang]

const STATUS: Record<string, string> = props.lang === 'ru'
  ? { thinking: 'Думаю…', router_decision: 'Понимаю вопрос…', searching_corpus: 'Ищу в лекциях…', browsing_catalog: 'Просматриваю каталог…', locating: 'Ищу место…', preparing_action: 'Готовлю ответ…', composing_answer: 'Составляю ответ…', synthesizing_answer: 'Составляю ответ…' }
  : { thinking: 'Thinking…', router_decision: 'Understanding…', searching_corpus: 'Searching the lectures…', browsing_catalog: 'Browsing the catalog…', locating: 'Locating…', preparing_action: 'Preparing…', composing_answer: 'Composing the answer…', synthesizing_answer: 'Composing the answer…' }

interface ResearchSource { kind?: string; id: string; label: string }
interface Msg {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  statusKey?: string
  researchQuestions?: string[]
  researchSources?: Map<string, ResearchSource>
  // payload maps keyed like the app's reducer, feeding the reused cards
  verses?: Map<string, any>
  chapters?: Map<string, any>
  cites?: Map<string, any>
  commentaries?: Map<string, any>
  media?: Map<string, any>
  outlines?: Map<string, any>
  pdfActions?: Map<string, any>
  aliases?: Record<string, any>
}

function captureAction(a: Msg, kind: string, p: any, actionId?: string) {
  if (kind === 'verse' && p.source_id != null) {
    a.verses!.set(`${p.source_id}|${p.tokens}`, {
      addrLabel: p.addr_label, sanskrit: p.sanskrit, transliteration: p.transliteration,
      transliterationOriginal: p.transliteration_original, translation: p.translation,
      audioUrl: p.audio_url, mt: p.mt,
    })
  } else if (kind === 'chapter' && p.source_id != null) {
    a.chapters!.set(`${p.source_id}|${p.region_token}`, {
      regionLabel: p.region_label,
      chapters: (p.chapters ?? []).map((c: any) => ({ tokens: c.tokens, title: c.title, titleOriginal: c.title_original })),
      mt: p.mt,
    })
  } else if (kind === 'cite_transcript' && p.track_id != null) {
    a.cites!.set(`${p.track_id}|${p.start_ms}-${p.end_ms}`, { text: p.text, mt: p.mt, textOriginal: p.text_original })
  } else if (kind === 'commentary') {
    // `[commentary:N]` → token.ref (a number). The payload carries `ref`
    // directly; fall back to the trailing number in `id` (`commentary_<N>`).
    const ref = p.ref != null ? p.ref : Number(String(p.id ?? '').match(/(\d+)$/)?.[1])
    if (Number.isFinite(ref)) {
      a.commentaries!.set(String(ref), {
        text: p.text, authorName: p.author_name, addrLabel: p.addr_label,
        commentaryKind: p.commentary_kind ?? p.kind, mt: p.mt, textOriginal: p.text_original,
      })
    }
  } else if (kind === 'media' && p.id != null) {
    a.media!.set(p.id, {
      id: p.id, url: p.url, type: p.type, title: p.title, speaker: p.speaker,
      text: p.text, mt: p.mt, textOriginal: p.text_original,
    })
  } else if (kind === 'outline' && p.track_id != null) {
    a.outlines!.set(p.track_id, {
      trackId: p.track_id,
      items: (p.items ?? []).map((it: any) => ({ startMs: it.start_ms, title: it.title })),
    })
  } else if (kind === 'share_pdf' && actionId != null) {
    a.pdfActions!.set(actionId, p)
  }
}
const messages = ref<Msg[]>([])
const input = ref('')
const busy = ref(false)
const turns = ref(0)
const srvLimit = ref<number | null>(null)
const srvCurrent = ref(0)
const capped = computed(() =>
  srvLimit.value !== null ? srvCurrent.value >= srvLimit.value : turns.value >= FREE_TURNS,
)
const left = computed(() =>
  srvLimit.value !== null
    ? Math.max(0, srvLimit.value - srvCurrent.value)
    : Math.max(0, FREE_TURNS - turns.value),
)
const failed = ref(false)
const scroller = ref<HTMLElement>()

let activeController: AbortController | null = null
let activeTraceId: string | null = null
let stopped = false

function stop() {
  stopped = true
  if (activeTraceId && token) {
    fetch(`${CHAT}/chat/turn/${activeTraceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  }
  activeController?.abort()
}

function statusLabelFor(m: Msg): string {
  return STATUS[m.statusKey ?? ''] ?? STATUS.thinking
}

let token: string | null = null

function deviceId(): string {
  const k = 'lts_device_id'
  let v = localStorage.getItem(k)
  if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v) }
  return v
}

async function ensureToken(): Promise<string> {
  if (token) return token
  const cached = sessionStorage.getItem('lts_chat_token')
  if (cached) { token = cached; return token }
  if (!AUTH) throw new Error('auth_unconfigured')
  const r = await fetch(`${AUTH}/auth/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId(), platform: 'web' }),
  })
  if (!r.ok) throw new Error('auth_failed')
  const j = await r.json()
  token = j.accessToken
  sessionStorage.setItem('lts_chat_token', token!)
  return token!
}

async function scrollDown() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}

async function send(text?: string) {
  const q = (text ?? input.value).trim()
  if (!q || busy.value || capped.value) return
  input.value = ''
  failed.value = false
  messages.value.push({ role: 'user', text: q })
  messages.value.push({
    role: 'assistant',
    text: '',
    streaming: true,
    researchQuestions: [],
    researchSources: new Map(),
    verses: new Map(),
    chapters: new Map(),
    cites: new Map(),
    commentaries: new Map(),
    media: new Map(),
    outlines: new Map(),
    pdfActions: new Map(),
  })
  // Reactive proxy of the assistant message so nested mutations re-render.
  const a = messages.value[messages.value.length - 1]
  busy.value = true
  stopped = false
  scrollDown()

  const traceId = crypto.randomUUID().replace(/-/g, '')
  const idem = crypto.randomUUID()
  activeTraceId = traceId
  const controller = new AbortController()
  activeController = controller
  let gotDone = false

  const handleEvent = (evt: string, payload: any) => {
    if (evt === 'delta' || payload?.text) { a.text += payload.text ?? ''; scrollDown() }
    else if (evt === 'status') { a.statusKey = payload?.key }
    else if (evt === 'research_question') { if (payload?.question) a.researchQuestions!.push(payload.question) }
    else if (evt === 'research_source') { if (payload?.id) a.researchSources!.set(payload.id, { kind: payload.kind, id: payload.id, label: payload.label ?? '' }) }
    else if (evt === 'action') { if (payload?.kind) captureAction(a, payload.kind, payload.payload ?? {}, payload.id) }
    else if (evt === 'usage') {
      let u: any = payload
      if (typeof u === 'string') { try { u = JSON.parse(u) } catch { u = null } }
      if (u && typeof u.limit === 'number') { srvLimit.value = u.limit; srvCurrent.value = u.current ?? srvCurrent.value }
    }
    else if (evt === 'done') { gotDone = true; if (payload?.aliases) a.aliases = payload.aliases }
    else if (evt === 'error') { throw new Error(payload?.code ?? 'error') }
  }

  const resume = async (jwt: string): Promise<boolean> => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      let j: any
      try {
        const rr = await fetch(`${CHAT}/chat/turn/${traceId}`, { headers: { Authorization: `Bearer ${jwt}` } })
        if (!rr.ok) continue
        j = await rr.json()
      } catch { continue }
      for (const e of j?.events ?? []) {
        let p: any = e.data
        if (typeof p === 'string') { try { p = JSON.parse(p) } catch { p = {} } }
        handleEvent(e.event, p ?? {})
      }
      if (j?.state === 'done' || j?.state === 'error') return true
    }
    return gotDone
  }

  try {
    if (!CHAT) throw new Error('chat_unconfigured')
    const history = messages.value
      .filter((m) => m.text)
      .map((m) => (m.role === 'assistant' && m.aliases
        ? { role: m.role, content: m.text, aliases: m.aliases }
        : { role: m.role, content: m.text }))
    const body: Record<string, unknown> = {
      messages: history.length ? history : [{ role: 'user', content: q }],
      lang: props.lang,
      capabilities: { commentary_card: true },
    }
    if (props.trackId) body.user_context = { current_track_id: props.trackId }

    const post = (jwt: string) =>
      fetch(`${CHAT}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'X-Chat-Protocol-Version': '1',
          'X-Trace-Id': traceId,
          'Idempotency-Key': idem,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

    let jwt = await ensureToken()
    let res = await post(jwt)
    // Anonymous access tokens expire (~15 min). On 401 mint a fresh one (same
    // deviceId → same quota bucket) and retry once.
    if (res.status === 401) {
      token = null
      sessionStorage.removeItem('lts_chat_token')
      jwt = await ensureToken()
      res = await post(jwt)
    }
    if (res.status === 429) { turns.value = FREE_TURNS; throw new Error('rate_limited') }
    if (!res.ok || !res.body) throw new Error('chat_failed')

    try {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let evt = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) { evt = line.slice(6).trim(); continue }
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          let payload: any
          try { payload = JSON.parse(data) } catch { continue }
          handleEvent(evt, payload)
        }
      }
    } catch (e) {
      if (stopped) throw e
      if (!gotDone) { if (!(await resume(jwt))) throw e }
    }

    if (!gotDone && !stopped) {
      if (!(await resume(jwt))) throw new Error('disconnected')
    }
    a.streaming = false
    turns.value++
  } catch {
    a.streaming = false
    if (stopped) {
      if (a.text === '') messages.value.pop()
    } else {
      if (a.text === '') messages.value.pop()
      failed.value = true
    }
  } finally {
    busy.value = false
    activeController = null
    activeTraceId = null
    scrollDown()
  }
}
</script>

<template>
  <div
    class="flex h-full flex-col overflow-hidden"
    :class="bare ? '' : 'rounded-3xl border border-line bg-cream-deep/40'"
  >
    <header v-if="!bare" class="border-b border-line bg-cream/70 px-5 py-4">
      <h2 class="font-serif text-lg font-bold text-ink">{{ L.title }}</h2>
      <p class="text-xs text-medium">{{ L.sub }}</p>
    </header>

    <div ref="scroller" class="app-scroll flex-1 space-y-5 overflow-y-auto px-5 py-5">
      <template v-if="!messages.length">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="s in L.suggestions"
            :key="s"
            class="rounded-full border border-line bg-cream px-4 py-2 text-sm text-ink-soft transition hover:border-saffron hover:text-saffron"
            @click="send(s)"
          >{{ s }}</button>
        </div>
      </template>

      <div v-for="(m, idx) in messages" :key="idx">
        <!-- user: chat bubble, right-aligned -->
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[86%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-saffron px-4 py-2.5 text-[0.95rem] leading-snug text-cream">{{ m.text }}</div>
        </div>
        <!-- assistant: full-width prose, NO bubble (matches the app) -->
        <div v-else class="text-[0.95rem] text-ink">
          <ChatMessageBody v-if="m.text" :text="m.text" :lang="props.lang" :verses="m.verses" :chapters="m.chapters" :cites="m.cites" :commentaries="m.commentaries" :media="m.media" :outlines="m.outlines" :pdf-actions="m.pdfActions" />
          <StatusPill
            v-if="m.streaming"
            :class="m.text ? 'mt-3' : ''"
            :status-label="statusLabelFor(m)"
            :research-questions="m.researchQuestions"
            :research-sources="m.researchSources"
          >
            <template #spinner><span class="dots-spinner" /></template>
          </StatusPill>
        </div>
      </div>

      <!-- graceful fallback / cap → install -->
      <div v-if="failed || capped" class="rounded-2xl border border-saffron/40 bg-saffron/10 p-5 text-center">
        <p class="font-serif text-base font-semibold text-ink">{{ capped ? L.capTitle : L.errTitle }}</p>
        <p class="mt-1 text-sm text-medium">{{ capped ? L.capBody : L.errBody }}</p>
        <div class="mt-4 flex flex-wrap justify-center gap-3">
          <a :href="STORE.appStore" target="_blank" rel="noopener" class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-cream hover:bg-coffee">App Store</a>
          <a :href="STORE.googlePlay" target="_blank" rel="noopener" class="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-cream hover:bg-coffee">Google Play</a>
        </div>
      </div>
    </div>

    <footer class="px-3 pb-4 pt-2">
      <p v-if="!capped && (srvLimit !== null || turns > 0)" class="mb-2 text-center text-xs text-medium">{{ L.left(left) }}</p>
      <ChatComposer
        :sending="busy"
        :disabled="capped"
        :placeholder="L.placeholder"
        :send-aria-label="L.send"
        @send="send"
        @cancel="stop"
      >
        <template #spinner><span class="dots-spinner" /></template>
      </ChatComposer>
    </footer>
  </div>
</template>
