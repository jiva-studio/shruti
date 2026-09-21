import type { Ref } from "vue"
import type { RunChatTurnEvent } from "@usecases"
// Type-only import — erased at runtime, so this does NOT create a runtime
// import cycle with the store.
import type { ChatMessage } from "./chat/chatTypes.js"

type StreamingKind =
  | "delta"
  | "tool-start"
  | "status"
  | "research-question"
  | "research-source"
  | "action"
  | "outline"
  | "verse-payload"
  | "chapter-payload"
  | "cite-transcript-payload"
  | "commentary-payload"
  | "media-payload"

type EventOf<K extends StreamingKind> = Extract<RunChatTurnEvent, { kind: K }>

type Patch<K extends StreamingKind> = (cur: ChatMessage, event: EventOf<K>) => Partial<ChatMessage>

/**
 * How each streaming event amends the bubble being written.
 *
 * The card maps (action / outline / verse / cite / chapter / commentary /
 * media) are stashed on the message itself so they round-trip through
 * `messages.create` → SQLite `meta` and still render after a reopen. A payload
 * arrives BEFORE the prose delta carrying its marker; the marker is what
 * triggers the card render.
 */
const PATCHES: { [K in StreamingKind]: Patch<K> } = {
  delta: (cur, event) => ({ content: cur.content + event.text }),

  // A tool re-run discards the first pass, so the prose and every per-turn
  // accumulator are cleared — otherwise the finalised message carries orphaned
  // cards from the abandoned pass. runChatTurn resets its own maps on the same
  // event, keeping the persisted message in lockstep.
  "tool-start": () => ({
    content: "",
    actions: undefined,
    outlines: undefined,
    media: undefined,
    verses: undefined,
    cites: undefined,
    chapters: undefined,
    commentaries: undefined,
    researchQuestions: undefined,
    researchSources: undefined,
  }),

  // Each status marks a new pipeline epoch, so the research lists are dropped
  // with it — stale sub-queries would keep rotating in the ticker.
  status: (_cur, event) => ({
    statusKey: event.statusKey,
    statusParams: event.params,
    researchQuestions: undefined,
    researchSources: undefined,
  }),

  // Research items are ephemeral: dropped on `finalised` (which replaces the
  // message) or `error` (which removes the placeholder).
  "research-question": (cur, event) => ({
    researchQuestions: [...(cur.researchQuestions ?? []), event.question],
  }),

  // Last-write-wins per id: the server emits per sub-query, so several
  // sub-queries inspecting the same chunk collapse into one chip.
  "research-source": (cur, event) => {
    const sources = new Map(cur.researchSources ?? new Map())
    sources.set(event.id, { sourceKind: event.sourceKind, label: event.label })
    return { researchSources: sources }
  },

  action: (cur, event) => ({
    actions: { ...(cur.actions ?? {}), [event.actionId]: event.payload },
  }),

  outline: (cur, event) => ({
    outlines: { ...(cur.outlines ?? {}), [event.trackId]: event.payload },
  }),

  "verse-payload": (cur, event) => ({
    verses: {
      ...(cur.verses ?? {}),
      [`${event.sourceId}|${event.tokens}`]: {
        addrLabel: event.addrLabel,
        sanskrit: event.sanskrit,
        transliteration: event.transliteration,
        transliterationOriginal: event.transliterationOriginal,
        lang: event.lang,
        translation: event.translation,
        audioUrl: event.audioUrl,
        mt: event.mt,
      },
    },
  }),

  "chapter-payload": (cur, event) => ({
    chapters: {
      ...(cur.chapters ?? {}),
      [`${event.sourceId}|${event.regionToken}`]: {
        regionLabel: event.regionLabel,
        chapters: event.chapters,
        ...(event.mt ? { mt: true } : {}),
      },
    },
  }),

  "cite-transcript-payload": (cur, event) => ({
    cites: {
      ...(cur.cites ?? {}),
      [`${event.trackId}|${event.startMs}-${event.endMs}`]: {
        text: event.text,
        mt: event.mt,
        textOriginal: event.textOriginal,
      },
    },
  }),

  // Keyed by the per-turn ref; living on the message rather than in a global
  // cache is what keeps a ref from colliding across messages.
  "commentary-payload": (cur, event) => ({
    commentaries: {
      ...(cur.commentaries ?? {}),
      [String(event.ref)]: {
        text: event.text,
        authorName: event.authorName,
        addrLabel: event.addrLabel,
        commentaryKind: event.commentaryKind,
        mt: event.mt,
        textOriginal: event.textOriginal,
      },
    },
  }),

  "media-payload": (cur, event) => ({
    media: { ...(cur.media ?? {}), [event.payload.id]: event.payload },
  }),
}

/**
 * Apply the streaming-accumulation subset of turn events to the on-screen
 * message list.
 *
 * These events mutate only the currently-streaming bubble, so they share one
 * data dependency — `messages` plus the `streamingIndex` of that bubble — and
 * live apart from `useChatStore`'s orchestration core. The lifecycle events
 * (`user-message`, `assistant-placeholder`, `finalised`, `usage`,
 * `title-updated`, `error`) touch broader store state and stay in the store.
 *
 * Returns `true` when the event was a streaming kind — applied, or a no-op
 * because no bubble is streaming — and `false` when the caller must fall
 * through to the lifecycle switch.
 */
export function applyStreamingTurnEvent(
  event: RunChatTurnEvent,
  messages: Ref<ChatMessage[]>,
  streamingIndex: () => number
): boolean {
  const patch = (PATCHES as Record<string, Patch<StreamingKind> | undefined>)[event.kind]
  if (!patch) return false

  const idx = streamingIndex()
  if (idx < 0) return true

  const next = [...messages.value]
  next[idx] = { ...next[idx], ...patch(next[idx], event as EventOf<StreamingKind>) }
  messages.value = next
  return true
}
