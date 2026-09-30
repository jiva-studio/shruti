import { computed, ref, toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue"
import type { ChatAttributes, ChatStreamEvent } from "@lib/contracts"
import { foldAction } from "@lib/chat/stream/chatActionFold.js"
import {
  aggregateAttributes,
  buildRequestEnvelope,
  windowChatHistory,
} from "@lib/chat/stream/chatRequestBody.js"
import {
  parseSseFrame,
  readSseFrame,
  readStoredFrame,
  splitSseBlocks,
  type SseFrame,
} from "@lib/chat/stream/sseParser.js"
import { actionBody, parseTrackCard, parseTrackDisplay } from "@lib/chat/stream/trackDisplay.js"
import { useWebAuth } from "./useWebAuth"
import type {
  CardPayload,
  ChapterPayload,
  CitationPayload,
  CommentaryPayload,
  OutlinePayload,
  PdfActionPayload,
  ResearchSource,
  VersePayload,
} from "../components/vue/types/chat"
import type { MediaPayload } from "../components/vue/types/media"

type Lang = "ru" | "en"

export interface Msg {
  role: "user" | "assistant"
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
  /** The alias map exactly as `done` shipped it, verse and chapter entries
   *  included, so the next request hands every one of them back. */
  aliases?: Record<string, unknown>
  /** What the server worked out about the conversation as of this turn (the
   *  reply language today). Sent back both on the message and folded into the
   *  request-level aggregate, so a setting keeps holding: the server sees only
   *  the last messages and can't find the request again once it scrolls out. */
  attributes?: ChatAttributes
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
  /** The track the chat is anchored to, read afresh on every send. */
  trackId?: MaybeRefOrGetter<string | undefined>
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

/**
 * Stash an action's card on the bubble. The shared fold decides the card and
 * its key; the site adds the attribution the server resolved for it, since
 * it has no catalog to look a lecture up in. `raw` is the action frame's body.
 */
function captureAction(
  a: Msg,
  event: Extract<ChatStreamEvent, { type: "action" }> | null,
  raw: Record<string, unknown>
): void {
  const card = parseTrackCard(raw)
  if (card) {
    a.cards!.set(card.trackId, card)
    return
  }
  const folded = event ? foldAction(event.payload) : null
  if (!folded) return
  const body = actionBody(raw)
  switch (folded.slot) {
    case "verses":
      a.verses!.set(folded.key, folded.body as VersePayload)
      return
    case "chapters":
      a.chapters!.set(folded.key, folded.body as ChapterPayload)
      return
    case "cites":
      a.cites!.set(folded.key, { ...(folded.body as CitationPayload), ...parseTrackDisplay(body) })
      return
    case "commentaries":
      a.commentaries!.set(folded.key, folded.body as CommentaryPayload)
      return
    case "media":
      a.media!.set(folded.key, folded.body as MediaPayload)
      return
    case "outlines": {
      const { trackTitle } = parseTrackDisplay(body)
      a.outlines!.set(folded.key, {
        ...(folded.body as OutlinePayload),
        ...(trackTitle ? { trackTitle } : {}),
      })
      return
    }
    case "actions":
      // The site renders only the PDF download; it keeps the body as the
      // server sent it, which is also the shape its history stores.
      if (event?.payload.kind === "share_pdf")
        a.pdfActions!.set(folded.key, body as PdfActionPayload)
      return
  }
}

/** Empty every field a stream event writes, keeping the bubble's identity
 *  (`traceId`, `id`, `createdAt`). The resume endpoint answers with the turn's
 *  whole buffer, so each replay starts from this state. */
function resetBubbleForReplay(a: Msg): void {
  a.text = ""
  a.streaming = true
  a.statusKey = undefined
  a.researchQuestions = []
  a.researchSources = new Map()
  a.verses = new Map()
  a.chapters = new Map()
  a.cites = new Map()
  a.cards = new Map()
  a.commentaries = new Map()
  a.media = new Map()
  a.outlines = new Map()
  a.pdfActions = new Map()
  a.aliases = undefined
  a.attributes = undefined
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
    srvLimit.value !== null ? srvCurrent.value >= srvLimit.value : turns.value >= freeTurns
  )
  const left = computed(() =>
    srvLimit.value !== null
      ? Math.max(0, srvLimit.value - srvCurrent.value)
      : Math.max(0, freeTurns - turns.value)
  )

  let activeController: AbortController | null = null
  let activeTraceId: string | null = null
  let stopped = false

  function stop() {
    stopped = true
    const token = auth.getToken()
    if (activeTraceId && token) {
      const traceId = activeTraceId
      fetch(`${chatBase}/chat/turn/${traceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch((err: unknown) => {
        console.warn(`[chat] cancelling turn ${traceId} on the server failed:`, err)
      })
    }
    activeController?.abort()
  }

  async function send(text: string) {
    const q = text.trim()
    if (!q || busy.value || capped.value) return
    failed.value = false
    messages.value.push({ role: "user", text: q })
    messages.value.push({
      role: "assistant",
      text: "",
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

    const traceId = crypto.randomUUID().replace(/-/g, "")
    const idem = crypto.randomUUID()
    activeTraceId = traceId
    a.traceId = traceId
    const controller = new AbortController()
    activeController = controller
    let gotDone = false

    const handleEvent = (event: ChatStreamEvent | null, raw: SseFrame | null) => {
      if (event?.type === "delta") {
        a.text += event.text
        onScroll()
      } else if (event?.type === "status") {
        a.statusKey = event.key
      } else if (event?.type === "research_question") {
        a.researchQuestions!.push(event.question)
      } else if (event?.type === "research_source") {
        a.researchSources!.set(event.id, {
          kind: event.sourceKind,
          id: event.id,
          label: event.label,
        })
      } else if (raw?.name === "action") {
        captureAction(a, event?.type === "action" ? event : null, raw.payload)
      } else if (event?.type === "usage") {
        srvLimit.value = event.limit
        srvCurrent.value = event.current
      } else if (event?.type === "done") {
        gotDone = true
        // Kept as it arrived: the decoded map holds lecture aliases only.
        const aliases = raw?.payload.aliases
        if (aliases && typeof aliases === "object") a.aliases = aliases as Record<string, unknown>
        if (event.attributes) a.attributes = event.attributes
      } else if (event?.type === "error") {
        throw new Error(event.code)
      }
    }

    const handleFrame = (frame: SseFrame | ChatStreamEvent | null) => {
      if (frame === null) return
      if ("type" in frame) handleEvent(frame, null)
      else handleEvent(parseSseFrame(frame), frame)
    }

    const resume = async (jwt: string): Promise<boolean> => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        let j: ResumeResponse | undefined
        try {
          const rr = await fetch(`${chatBase}/chat/turn/${traceId}`, {
            headers: { Authorization: `Bearer ${jwt}` },
          })
          if (!rr.ok) continue
          j = await rr.json()
        } catch {
          continue
        }
        const events = j?.events ?? []
        if (events.length > 0) resetBubbleForReplay(a)
        for (const e of events) {
          const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? {})
          handleFrame(readStoredFrame({ event: e.event, data }))
        }
        if (j?.state === "done" || j?.state === "error") return true
      }
      return gotDone
    }

    try {
      if (!chatBase) throw new Error("chat_unconfigured")
      // `withAliases=false` drops the server-minted alias maps from history —
      // the resilience path for a chat backend whose request schema predates
      // the verse/commentary alias shapes and 422s on them (see below).
      const buildBody = (withAliases: boolean): Record<string, unknown> => {
        // Windowed like mobile; the attribute aggregate below still folds the full history.
        const history = windowChatHistory(messages.value.filter((m) => m.text)).map((m) => {
          const t: Record<string, unknown> = { role: m.role, content: m.text }
          if (!withAliases || m.role !== "assistant") return t
          if (m.aliases) t.aliases = m.aliases
          if (m.attributes) t.attributes = m.attributes
          return t
        })
        const attributed = messages.value.map((m) => ({
          role: m.role,
          content: m.text,
          attributes: m.attributes,
        }))
        const currentTrackId = toValue(trackId)
        return buildRequestEnvelope(
          history,
          withAliases ? aggregateAttributes(attributed) : undefined,
          lang,
          {
            capabilities: { commentary_card: true },
            // Web always opts in: there's no per-user toggle here, and the corpus
            // has native transcripts only for ru/en — so for any other `lang` the
            // server would otherwise show English-verbatim citations.
            translateCitations: true,
            userContext: currentTrackId ? { current_track_id: currentTrackId } : undefined,
          }
        )
      }

      const post = (jwt: string, bodyObj: Record<string, unknown>) =>
        fetch(`${chatBase}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
            "X-Chat-Protocol-Version": "1",
            "X-Trace-Id": traceId,
            "Idempotency-Key": idem,
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
      if (res.status === 429) {
        turns.value = freeTurns
        throw new Error("rate_limited")
      }
      if (!res.ok || !res.body) throw new Error("chat_failed")

      try {
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const { blocks, rest } = splitSseBlocks(buf + dec.decode(value, { stream: true }))
          buf = rest
          for (const block of blocks) handleFrame(readSseFrame(block))
        }
      } catch (e) {
        if (stopped) throw e
        if (!gotDone) {
          if (!(await resume(jwt))) throw e
        }
      }

      if (!gotDone && !stopped) {
        if (!(await resume(jwt))) throw new Error("disconnected")
      }
      a.streaming = false
      turns.value++
    } catch {
      a.streaming = false
      if (stopped) {
        if (a.text === "") messages.value.pop()
      } else {
        if (a.text === "") messages.value.pop()
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

  return {
    messages,
    busy,
    turns,
    srvLimit,
    srvCurrent,
    failed,
    capped,
    left,
    send,
    stop,
    resetLimits,
  }
}
