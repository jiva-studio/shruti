import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useWebAuth } from './useWebAuth'
import type {
  CardPayload,
  ChapterPayload,
  CitationPayload,
  CommentaryPayload,
  OutlinePayload,
  PdfActionPayload,
  ResearchSource,
  VersePayload,
} from '../components/vue/types/chat'
import type { MediaPayload } from '../components/vue/types/media'

type Lang = 'ru' | 'en'

export interface Msg {
  role: 'user' | 'assistant'
  text: string
  /** Stable per-message id, assigned when the message is first persisted;
   *  the sync doc_id so a message dedupes across devices and reloads. */
  id?: string
  /** Creation time (unix ms), assigned at first persist; orders messages
   *  within a session for sync merge. */
  createdAt?: number
  streaming?: boolean
  statusKey?: string
  /** Per-turn Langfuse trace id (hyphenless uuid4). Set on the assistant
   *  message once the turn is dispatched; used as the feedback POST id so
   *  thumbs up/down attach to the same trace (mirrors the mobile client). */
  traceId?: string
  researchQuestions?: string[]
  researchSources?: Map<string, ResearchSource>
  verses?: Map<string, VersePayload>
  chapters?: Map<string, ChapterPayload>
  cites?: Map<string, CitationPayload>
  cards?: Map<string, CardPayload>
  commentaries?: Map<string, CommentaryPayload>
  media?: Map<string, MediaPayload>
  outlines?: Map<string, OutlinePayload>
  pdfActions?: Map<string, PdfActionPayload>
  aliases?: Record<string, unknown>
  /** What the server worked out about the conversation as of this turn (the
   *  reply language today). Sent back both on the message and folded into the
   *  request-level aggregate, so a setting keeps holding: the server sees only
   *  the last messages and can't find the request again once it scrolls out. */
  attributes?: ChatAttributes
}

/** One thing the server settled about the conversation. `value` is opaque —
 *  for the reply language it's a locale code that is NOT one of the UI
 *  languages (an Italian question is answered in Italian though there's no
 *  Italian interface). `explicit` is true when the user stated it rather than
 *  us inferring it. Keyed so a new attribute needs no client change. */
export interface ChatAttribute {
  /** Isomorphic: a bare string for a single-valued attribute (the reply
   *  language), an array for a multi-valued one (which lecturers to draw on). */
  value: string | string[]
  label: string
  explicit: boolean
}

/** The attribute's values, whichever shape the wire used. */
function attrValues(attr: ChatAttribute): string[] {
  return typeof attr.value === 'string' ? [attr.value] : attr.value
}

export type ChatAttributes = Record<string, ChatAttribute>

interface ActionEnvelope {
  kind?: string
  payload?: Record<string, unknown>
  id?: string
}

interface StreamEventPayload {
  text?: string
  key?: string
  question?: string
  id?: string
  kind?: string
  label?: string
  payload?: Record<string, unknown>
  aliases?: Record<string, unknown>
  attributes?: Record<string, unknown>
  code?: string
  limit?: number
  current?: number
}

interface ResumeEvent {
  event: string
  data: unknown
}

interface ResumeResponse {
  events?: ResumeEvent[]
  state?: string
}

export interface UseChatStreamOptions {
  chatBase: string
  lang: Lang
  trackId?: string
  freeTurns: number
  onScroll: () => void
}

export interface UseChatStream {
  messages: Ref<Msg[]>
  busy: Ref<boolean>
  turns: Ref<number>
  srvLimit: Ref<number | null>
  srvCurrent: Ref<number>
  failed: Ref<boolean>
  capped: ComputedRef<boolean>
  left: ComputedRef<number>
  send: (q: string) => Promise<void>
  stop: () => void
  resetLimits: () => void
}

/** Read settled attributes off a `done` frame. An entry with no value is a
 *  malformed frame (the server only sends what it settled); an entry with an
 *  unknown KEY is kept and carried forward, which is what lets the server add
 *  an attribute without a client release. */
function parseAttributes(raw: unknown): ChatAttributes | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: ChatAttributes = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    const rawValue = o.value
    const listed =
      typeof rawValue === 'string'
        ? [rawValue]
        : Array.isArray(rawValue)
          ? rawValue.filter((v): v is string => typeof v === 'string')
          : []
    // Same normalisation as the server: trim, drop blanks, de-duplicate.
    const clean = [...new Set(listed.map((v) => v.trim()).filter((v) => v.length > 0))]
    if (clean.length === 0) continue
    out[key] = {
      value: typeof rawValue === 'string' ? clean[0]! : clean,
      label: typeof o.label === 'string' ? o.label : '',
      explicit: o.explicit === true,
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Fold every turn's attributes into the map sent as request metadata. The
 *  server sees only the last messages, so a setting from turn 1 of a long
 *  dialogue reaches it only this way. Same rule as the server's merge: a later
 *  turn wins, but a later inference does not overwrite what the user stated. */
function aggregateAttributes(messages: readonly Msg[]): ChatAttributes | undefined {
  const out: ChatAttributes = {}
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.attributes) continue
    for (const [key, attr] of Object.entries(m.attributes)) {
      if (attrValues(attr).length === 0) continue
      const previous = out[key]
      if (previous && previous.explicit && !attr.explicit) continue
      out[key] = attr
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function captureAction(a: Msg, kind: string, p: Record<string, unknown>, actionId?: string) {
  if (kind === 'verse' && p.source_id != null) {
    a.verses!.set(`${p.source_id}|${p.tokens}`, {
      addrLabel: p.addr_label, sanskrit: p.sanskrit, transliteration: p.transliteration,
      transliterationOriginal: p.transliteration_original, lang: p.lang,
      translation: p.translation,
      audioUrl: p.audio_url, mt: p.mt,
    } as VersePayload)
  } else if (kind === 'chapter' && p.source_id != null) {
    const chapters = (Array.isArray(p.chapters) ? p.chapters : []) as Record<string, unknown>[]
    a.chapters!.set(`${p.source_id}|${p.region_token}`, {
      regionLabel: p.region_label,
      chapters: chapters.map((c) => ({ tokens: c.tokens, title: c.title, titleOriginal: c.title_original })),
      mt: p.mt,
    } as ChapterPayload)
  } else if (kind === 'cite_transcript' && p.track_id != null) {
    const refs = (Array.isArray(p.references) ? p.references : []) as Record<string, unknown>[]
    a.cites!.set(`${p.track_id}|${p.start_ms}-${p.end_ms}`, {
      text: p.text, mt: p.mt, textOriginal: p.text_original,
      trackTitle: p.track_title, authorName: p.author_name, trackDate: p.date,
      references: refs.map((r) => ({ sourceId: r.source_id, tokens: r.tokens, label: r.label })),
    } as CitationPayload)
  } else if (kind === 'card' && p.track_id != null) {
    const refs = (Array.isArray(p.references) ? p.references : []) as Record<string, unknown>[]
    a.cards!.set(String(p.track_id), {
      trackId: String(p.track_id),
      trackTitle: p.track_title, authorName: p.author_name, trackDate: p.date,
      references: refs.map((r) => ({ sourceId: r.source_id, tokens: r.tokens, label: r.label })),
    } as CardPayload)
  } else if (kind === 'commentary') {
    const ref = p.ref != null ? p.ref : Number(String(p.id ?? '').match(/(\d+)$/)?.[1])
    if (Number.isFinite(ref)) {
      a.commentaries!.set(String(ref), {
        text: p.text, authorName: p.author_name, addrLabel: p.addr_label,
        commentaryKind: p.commentary_kind ?? p.kind, mt: p.mt, textOriginal: p.text_original,
      } as CommentaryPayload)
    }
  } else if (kind === 'media' && p.id != null) {
    a.media!.set(String(p.id), {
      id: p.id, url: p.url, type: p.type, title: p.title, speaker: p.speaker, date: p.date,
      text: p.text, mt: p.mt, textOriginal: p.text_original,
    } as MediaPayload)
  } else if (kind === 'outline' && p.track_id != null) {
    const items = (Array.isArray(p.items) ? p.items : []) as Record<string, unknown>[]
    a.outlines!.set(String(p.track_id), {
      trackId: p.track_id,
      items: items.map((it) => ({ startMs: it.start_ms, title: it.title })),
      trackTitle: p.track_title,
    } as OutlinePayload)
  } else if (kind === 'share_pdf' && actionId != null) {
    a.pdfActions!.set(actionId, p as PdfActionPayload)
  }
}

export function useChatStream(options: UseChatStreamOptions): UseChatStream {
  const { chatBase, lang, trackId, freeTurns, onScroll } = options
  const auth = useWebAuth()

  const messages = ref<Msg[]>([])
  const busy = ref(false)
  const turns = ref(0)
  const srvLimit = ref<number | null>(null)
  const srvCurrent = ref(0)
  const failed = ref(false)

  const capped = computed(() =>
    srvLimit.value !== null ? srvCurrent.value >= srvLimit.value : turns.value >= freeTurns,
  )
  const left = computed(() =>
    srvLimit.value !== null
      ? Math.max(0, srvLimit.value - srvCurrent.value)
      : Math.max(0, freeTurns - turns.value),
  )

  let activeController: AbortController | null = null
  let activeTraceId: string | null = null
  let stopped = false

  function stop() {
    stopped = true
    const token = auth.getToken()
    if (activeTraceId && token) {
      fetch(`${chatBase}/chat/turn/${activeTraceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
    activeController?.abort()
  }

  async function send(text: string) {
    const q = text.trim()
    if (!q || busy.value || capped.value) return
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
      cards: new Map(),
      commentaries: new Map(),
      media: new Map(),
      outlines: new Map(),
      pdfActions: new Map(),
    })
    const a = messages.value[messages.value.length - 1]
    busy.value = true
    stopped = false
    onScroll()

    const traceId = crypto.randomUUID().replace(/-/g, '')
    const idem = crypto.randomUUID()
    activeTraceId = traceId
    a.traceId = traceId
    const controller = new AbortController()
    activeController = controller
    let gotDone = false

    const handleEvent = (evt: string, payload: StreamEventPayload) => {
      if (evt === 'delta' || payload?.text) { a.text += payload.text ?? ''; onScroll() }
      else if (evt === 'status') { a.statusKey = payload?.key }
      else if (evt === 'research_question') { if (payload?.question) a.researchQuestions!.push(payload.question) }
      else if (evt === 'research_source') { if (payload?.id) a.researchSources!.set(payload.id, { kind: payload.kind, id: payload.id, label: payload.label ?? '' }) }
      else if (evt === 'action') {
        const env = payload as ActionEnvelope
        if (env?.kind) captureAction(a, env.kind, env.payload ?? {}, env.id)
      }
      else if (evt === 'usage') {
        let u: unknown = payload
        if (typeof u === 'string') { try { u = JSON.parse(u) } catch { u = null } }
        if (u && typeof (u as StreamEventPayload).limit === 'number') {
          const usage = u as StreamEventPayload
          srvLimit.value = usage.limit!; srvCurrent.value = usage.current ?? srvCurrent.value
        }
      }
      else if (evt === 'done') {
        gotDone = true
        if (payload?.aliases) a.aliases = payload.aliases
        const attrs = parseAttributes(payload?.attributes)
        if (attrs) a.attributes = attrs
      }
      else if (evt === 'error') { throw new Error(payload?.code ?? 'error') }
    }

    const resume = async (jwt: string): Promise<boolean> => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        let j: ResumeResponse | undefined
        try {
          const rr = await fetch(`${chatBase}/chat/turn/${traceId}`, { headers: { Authorization: `Bearer ${jwt}` } })
          if (!rr.ok) continue
          j = await rr.json()
        } catch { continue }
        for (const e of j?.events ?? []) {
          let p: unknown = e.data
          if (typeof p === 'string') { try { p = JSON.parse(p) } catch { p = {} } }
          handleEvent(e.event, (p ?? {}) as StreamEventPayload)
        }
        if (j?.state === 'done' || j?.state === 'error') return true
      }
      return gotDone
    }

    try {
      if (!chatBase) throw new Error('chat_unconfigured')
      // `withAliases=false` drops the server-minted alias maps from history —
      // the resilience path for a chat backend whose request schema predates
      // the verse/commentary alias shapes and 422s on them (see below).
      const buildBody = (withAliases: boolean): Record<string, unknown> => {
        const history = messages.value
          .filter((m) => m.text)
          .map((m) => {
            const t: Record<string, unknown> = { role: m.role, content: m.text }
            if (!withAliases || m.role !== 'assistant') return t
            if (m.aliases) t.aliases = m.aliases
            if (m.attributes) t.attributes = m.attributes
            return t
          })
        const attributes = withAliases ? aggregateAttributes(messages.value) : undefined
        const b: Record<string, unknown> = {
          messages: history.length ? history : [{ role: 'user', content: q }],
          lang,
          ...(attributes ? { attributes } : {}),
          capabilities: { commentary_card: true },
          // Web always opts in: there's no per-user toggle here, and the corpus
          // has native transcripts only for ru/en — so for any other `lang` the
          // server would otherwise show English-verbatim citations.
          translate_citations: true,
        }
        if (trackId) b.user_context = { current_track_id: trackId }
        return b
      }

      const post = (jwt: string, bodyObj: Record<string, unknown>) =>
        fetch(`${chatBase}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`,
            'X-Chat-Protocol-Version': '1',
            'X-Trace-Id': traceId,
            'Idempotency-Key': idem,
          },
          body: JSON.stringify(bodyObj),
          signal: controller.signal,
        })

      let jwt = await auth.ensureToken()
      let res = await post(jwt, buildBody(true))
      if (res.status === 401) {
        auth.resetToken()
        jwt = await auth.ensureToken()
        res = await post(jwt, buildBody(true))
      }
      // Older backend rejects the rich alias shape (verse/commentary/…) with a
      // 422 schema error. Retry once without aliases so the turn still goes
      // through — prior-turn chip markers degrade to placeholders rather than
      // the whole conversation failing. A backend with the widened schema never
      // hits this and keeps the full alias fidelity.
      if (res.status === 422) res = await post(jwt, buildBody(false))
      if (res.status === 429) { turns.value = freeTurns; throw new Error('rate_limited') }
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
            let payload: StreamEventPayload
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
      onScroll()
    }
  }

  function resetLimits() {
    turns.value = 0
    srvLimit.value = null
    srvCurrent.value = 0
    failed.value = false
  }

  return { messages, busy, turns, srvLimit, srvCurrent, failed, capped, left, send, stop, resetLimits }
}
