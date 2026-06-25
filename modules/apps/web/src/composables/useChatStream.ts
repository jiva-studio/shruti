import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useChatAuth } from './useChatAuth'
import type {
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
  streaming?: boolean
  statusKey?: string
  researchQuestions?: string[]
  researchSources?: Map<string, ResearchSource>
  verses?: Map<string, VersePayload>
  chapters?: Map<string, ChapterPayload>
  cites?: Map<string, CitationPayload>
  commentaries?: Map<string, CommentaryPayload>
  media?: Map<string, MediaPayload>
  outlines?: Map<string, OutlinePayload>
  pdfActions?: Map<string, PdfActionPayload>
  aliases?: Record<string, unknown>
}

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
  authBase: string
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
}

function captureAction(a: Msg, kind: string, p: Record<string, unknown>, actionId?: string) {
  if (kind === 'verse' && p.source_id != null) {
    a.verses!.set(`${p.source_id}|${p.tokens}`, {
      addrLabel: p.addr_label, sanskrit: p.sanskrit, transliteration: p.transliteration,
      transliterationOriginal: p.transliteration_original, translation: p.translation,
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
  const { authBase, chatBase, lang, trackId, freeTurns, onScroll } = options
  const auth = useChatAuth(authBase)

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
      else if (evt === 'done') { gotDone = true; if (payload?.aliases) a.aliases = payload.aliases }
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
      const history = messages.value
        .filter((m) => m.text)
        .map((m) => (m.role === 'assistant' && m.aliases
          ? { role: m.role, content: m.text, aliases: m.aliases }
          : { role: m.role, content: m.text }))
      const body: Record<string, unknown> = {
        messages: history.length ? history : [{ role: 'user', content: q }],
        lang,
        capabilities: { commentary_card: true },
      }
      if (trackId) body.user_context = { current_track_id: trackId }

      const post = (jwt: string) =>
        fetch(`${chatBase}/chat`, {
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

      let jwt = await auth.ensureToken()
      let res = await post(jwt)
      if (res.status === 401) {
        auth.resetToken()
        jwt = await auth.ensureToken()
        res = await post(jwt)
      }
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

  return { messages, busy, turns, srvLimit, srvCurrent, failed, capped, left, send, stop }
}
