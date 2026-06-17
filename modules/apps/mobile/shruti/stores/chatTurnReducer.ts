import type { Ref } from "vue"
import type { RunChatTurnEvent } from "@usecases"
// Type-only import — erased at runtime, so this does NOT create a runtime
// import cycle with the store (the store imports this module's function).
import type { ChatMessage } from "@shruti/stores/useChatStore.js"

/**
 * Apply the "streaming-accumulation" subset of turn events to the on-screen
 * message list.
 *
 * These are the events that mutate ONLY the currently-streaming bubble — prose
 * deltas, the status/research progress chips, and the per-message card maps
 * (action / outline / verse / cite / chapter / commentary / media). They all
 * share exactly one data dependency: `messages` + the `streamingIndex` of the
 * bubble being written, so they live apart from `useChatStore`'s orchestration
 * core. The lifecycle events that touch broader store state — `user-message`,
 * `assistant-placeholder`, `finalised`, `usage`, `title-updated`, `error` —
 * are NOT handled here; the store keeps those.
 *
 * Returns `true` when the event was one of the streaming kinds (and applied,
 * or a no-op because no bubble is streaming), `false` otherwise so the caller
 * falls through to the lifecycle switch. Mirrors the `media`-style pattern:
 * the card bodies are stashed on the message so they round-trip through
 * `messages.create` → SQLite `meta` and survive a reopen.
 */
export function applyStreamingTurnEvent(
  event: RunChatTurnEvent,
  messages: Ref<ChatMessage[]>,
  streamingIndex: () => number
): boolean {
  switch (event.kind) {
    case "delta": {
      const idx = streamingIndex()
      if (idx < 0) return true
      const next = [...messages.value]
      next[idx] = { ...next[idx], content: next[idx].content + event.text }
      messages.value = next
      return true
    }
    case "tool-start": {
      // A tool re-run discards the first pass: clear the prose AND the
      // per-turn card accumulators (action/outline/media + the verse/
      // chapter/cite/commentary bodies now stashed on the message) plus
      // the ephemeral research lists on the bubble, so the finalised
      // message can't carry orphaned cards from the abandoned pass.
      // (runChatTurn resets its own closure-side maps on the same event,
      // keeping the persisted message in lockstep.)
      const idx = streamingIndex()
      if (idx < 0) return true
      const next = [...messages.value]
      next[idx] = {
        ...next[idx],
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
      }
      messages.value = next
      return true
    }
    case "status": {
      // i18n status key from the server (e.g. "searching_corpus",
      // "composing_answer"). Surfaced as `statusKey` on the streaming
      // bubble so StatusPill.vue can render the localized label
      // without polling.
      //
      // We also clear the accumulated `researchQuestions` /
      // `researchSources` here — each status event marks a new
      // pipeline epoch, and stale research items would otherwise
      // keep showing up in the ticker rotation after the server
      // moved on (e.g. when `composing_answer` lands, the user
      // doesn't want to keep seeing "природа buddhi" sub-queries).
      const idx = streamingIndex()
      if (idx < 0) return true
      const next = [...messages.value]
      next[idx] = {
        ...next[idx],
        statusKey: event.statusKey,
        statusParams: event.params,
        researchQuestions: undefined,
        researchSources: undefined,
      }
      messages.value = next
      return true
    }
    case "research-question": {
      // Append a sub-query the research pipeline just generated.
      // Ephemeral — lives on the streaming bubble only; dropped on
      // `finalised` (which replaces the whole message) or `error`
      // (which removes the placeholder).
      const idx = streamingIndex()
      if (idx < 0) return true
      const cur = messages.value[idx]
      const next = [...messages.value]
      next[idx] = {
        ...cur,
        researchQuestions: [...(cur.researchQuestions ?? []), event.question],
      }
      messages.value = next
      return true
    }
    case "research-source": {
      // Add (or replace, last-write-wins) one inspected source.
      // Dedup happens here — server emits per-query, multiple
      // sub-queries inspecting the same chunk collapse into one chip.
      const idx = streamingIndex()
      if (idx < 0) return true
      const cur = messages.value[idx]
      const nextMap = new Map(cur.researchSources ?? new Map())
      nextMap.set(event.id, { sourceKind: event.sourceKind, label: event.label })
      const next = [...messages.value]
      next[idx] = { ...cur, researchSources: nextMap }
      messages.value = next
      return true
    }
    case "action": {
      const idx = streamingIndex()
      if (idx < 0) return true
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
        actions: { ...(cur.actions ?? {}), [event.actionId]: event.payload },
      }
      messages.value = next
      return true
    }
    case "outline": {
      const idx = streamingIndex()
      if (idx < 0) return true
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
        outlines: { ...(cur.outlines ?? {}), [event.trackId]: event.payload },
      }
      messages.value = next
      return true
    }
    case "verse-payload": {
      // Verse body for one (source_id, tokens), stashed on the streaming
      // message's `verses` map — mirroring `media-payload` — so it
      // round-trips through `messages.create` → SQLite `meta` and the
      // card still renders when the answer is reopened long after the
      // turn. Arrives BEFORE the prose delta with the marker; the marker
      // is what triggers VerseCard render.
      const idx = streamingIndex()
      if (idx < 0) return true
      const key = `${event.sourceId}|${event.tokens}`
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
        verses: {
          ...(cur.verses ?? {}),
          [key]: {
            addrLabel: event.addrLabel,
            sanskrit: event.sanskrit,
            transliteration: event.transliteration,
            transliterationOriginal: event.transliterationOriginal,
            translation: event.translation,
            audioUrl: event.audioUrl,
            mt: event.mt,
          },
        },
      }
      messages.value = next
      return true
    }
    case "chapter-payload": {
      // Chapter-location region (locate intent), stashed on the streaming
      // message's `chapters` map — same ordering + persistence contract
      // as verse-payload.
      const idx = streamingIndex()
      if (idx < 0) return true
      const key = `${event.sourceId}|${event.regionToken}`
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
        chapters: {
          ...(cur.chapters ?? {}),
          [key]: { regionLabel: event.regionLabel, chapters: event.chapters },
        },
      }
      messages.value = next
      return true
    }
    case "cite-transcript-payload": {
      // Transcript snippet for one cited fragment, stashed on the
      // streaming message's `cites` map. A late arrival upgrades the chip
      // to the full card reactively; persisted so it survives a reopen.
      const idx = streamingIndex()
      if (idx < 0) return true
      const key = `${event.trackId}|${event.startMs}-${event.endMs}`
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
        cites: {
          ...(cur.cites ?? {}),
          [key]: { text: event.text, mt: event.mt, textOriginal: event.textOriginal },
        },
      }
      messages.value = next
      return true
    }
    case "commentary-payload": {
      // Purport / prose-chapter / letter quote for one `[commentary:N]`
      // marker, stashed on the streaming message's `commentaries` map
      // keyed by the per-turn ref. Living on the message (not a global
      // cache) is also what keeps a ref from colliding across messages.
      const idx = streamingIndex()
      if (idx < 0) return true
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
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
      }
      messages.value = next
      return true
    }
    case "media-payload": {
      // Server-streamed media result (video/audio + transcript) for one
      // `[media:<id>]` marker, stashed directly on the message's `media`
      // map — mirroring the `action` event — so it round-trips through
      // `messages.create` → SQLite `meta`. Arrives BEFORE the prose delta
      // with the marker; the marker triggers MediaCard render.
      const idx = streamingIndex()
      if (idx < 0) return true
      const next = [...messages.value]
      const cur = next[idx]
      next[idx] = {
        ...cur,
        media: { ...(cur.media ?? {}), [event.payload.id]: event.payload },
      }
      messages.value = next
      return true
    }
    default:
      return false
  }
}
