import type {
  ChatActionPayload,
  ChatAliasEntry,
  ChatChapterBody,
  ChatCiteSnippet,
  ChatCommentaryBody,
  ChatOutlinePayload,
  ChatVerseBody,
  MediaPayload,
} from "@lib/domain/chatMessage.js"
import type { ChatActionPayload as WireChatActionPayload, ChatStreamEvent } from "@lib/contracts"
import type { RunChatTurnEvent } from "./chatTurnEvents.js"
import { unwrapInteractiveAction } from "./interactiveAction.js"

/** Keyed as the matching `ChatMessage` fields, so the finalised message
 *  persists them and a card survives a reopen. */
export interface TurnCards {
  actions: Record<string, ChatActionPayload>
  outlines: Record<string, ChatOutlinePayload>
  media: Record<string, MediaPayload>
  verses: Record<string, ChatVerseBody>
  cites: Record<string, ChatCiteSnippet>
  chapters: Record<string, ChatChapterBody>
  commentaries: Record<string, ChatCommentaryBody>
}

export function createTurnCards(): TurnCards {
  return {
    actions: {},
    outlines: {},
    media: {},
    verses: {},
    cites: {},
    chapters: {},
    commentaries: {},
  }
}

/** A re-run of a tool discards the first pass entirely, or the finalised
 *  message would carry cards emitted before the tool re-ran. */
export function clearTurnCards(cards: TurnCards): void {
  for (const slot of Object.values(cards)) {
    for (const key of Object.keys(slot)) delete slot[key]
  }
}

/** Where a folded action is stashed, and what the consumer is told about it. */
export interface FoldedAction {
  readonly slot: keyof TurnCards
  readonly key: string
  readonly body: unknown
  readonly event: RunChatTurnEvent
}

type WireAction = Extract<ChatStreamEvent, { type: "action" }>["payload"]

/** `null` on a malformed payload, so a server bug does not crash the bubble. */
export function foldAction(wire: WireAction): FoldedAction | null {
  switch (wire.kind) {
    case "outline":
      return foldOutline(wire.payload)
    case "verse":
      return foldVerse(wire.payload)
    case "cite_transcript":
      return foldCite(wire.payload)
    case "commentary":
      return foldCommentary(wire.payload)
    case "chapter":
      return foldChapter(wire.payload)
    case "media":
      return foldMedia(wire.payload)
    default:
      return foldInteractive(wire as WireChatActionPayload)
  }
}

function foldOutline(p: ChatOutlinePayload): FoldedAction {
  return {
    slot: "outlines",
    key: p.trackId,
    body: p,
    event: { kind: "outline", trackId: p.trackId, payload: p },
  }
}

function foldVerse(p: Extract<WireAction, { kind: "verse" }>["payload"]): FoldedAction {
  const body: ChatVerseBody = {
    addrLabel: p.addr_label,
    sanskrit: p.sanskrit,
    transliteration: p.transliteration,
    transliterationOriginal: p.transliteration_original,
    lang: p.lang,
    translation: p.translation,
    audioUrl: p.audio_url,
    mt: p.mt,
  }
  return {
    slot: "verses",
    key: `${p.source_id}|${p.tokens}`,
    body,
    event: {
      kind: "verse-payload",
      sourceId: p.source_id,
      tokens: p.tokens,
      addrLabel: p.addr_label,
      sanskrit: p.sanskrit,
      transliteration: p.transliteration,
      transliterationOriginal: p.transliteration_original,
      lang: p.lang,
      translation: p.translation,
      audioUrl: p.audio_url,
      mt: p.mt,
    },
  }
}

function foldCite(p: Extract<WireAction, { kind: "cite_transcript" }>["payload"]): FoldedAction {
  const body: ChatCiteSnippet = { text: p.text, mt: p.mt, textOriginal: p.text_original }
  return {
    slot: "cites",
    key: `${p.track_id}|${p.start_ms}-${p.end_ms}`,
    body,
    event: {
      kind: "cite-transcript-payload",
      trackId: p.track_id,
      startMs: p.start_ms,
      endMs: p.end_ms,
      text: p.text,
      mt: p.mt,
      textOriginal: p.text_original,
    },
  }
}

function foldCommentary(p: Extract<WireAction, { kind: "commentary" }>["payload"]): FoldedAction {
  const body: ChatCommentaryBody = {
    text: p.text,
    authorName: p.author_name,
    addrLabel: p.addr_label,
    commentaryKind: p.kind,
    mt: p.mt,
    textOriginal: p.text_original,
  }
  return {
    slot: "commentaries",
    key: String(p.ref),
    body,
    event: {
      kind: "commentary-payload",
      ref: p.ref,
      text: p.text,
      authorName: p.author_name,
      addrLabel: p.addr_label,
      commentaryKind: p.kind,
      mt: p.mt,
      textOriginal: p.text_original,
    },
  }
}

function foldChapter(p: Extract<WireAction, { kind: "chapter" }>["payload"]): FoldedAction {
  // `title_original` rides along so the card can disclose the machine
  // translation instead of passing MT'd canto titles off as the book's own.
  const chapters = p.chapters.map((c) => ({
    tokens: c.tokens,
    title: c.title,
    ...(c.title_original ? { titleOriginal: c.title_original } : {}),
  }))
  const body: ChatChapterBody = {
    regionLabel: p.region_label,
    chapters,
    ...(p.mt ? { mt: true } : {}),
  }
  return {
    slot: "chapters",
    key: `${p.source_id}|${p.region_token}`,
    body,
    event: {
      kind: "chapter-payload",
      sourceId: p.source_id,
      regionToken: p.region_token,
      regionLabel: p.region_label,
      chapters,
      ...(p.mt ? { mt: true } : {}),
    },
  }
}

function foldMedia(w: Extract<WireAction, { kind: "media" }>["payload"]): FoldedAction {
  const body: MediaPayload = {
    id: w.id,
    url: w.url,
    type: w.type,
    title: w.title,
    text: w.text,
    ...(w.speaker ? { speaker: w.speaker } : {}),
    ...(w.date ? { date: w.date } : {}),
    ...(w.mt ? { mt: true } : {}),
    ...(w.text_original ? { textOriginal: w.text_original } : {}),
  }
  return { slot: "media", key: body.id, body, event: { kind: "media-payload", payload: body } }
}

function foldInteractive(wire: WireChatActionPayload): FoldedAction | null {
  const flat = unwrapInteractiveAction(wire)
  if (flat === null) return null
  return {
    slot: "actions",
    key: flat.id,
    body: flat,
    event: { kind: "action", actionId: flat.id, payload: flat },
  }
}

/** The alias map ships inline with `done`. Persisted on the finalised message
 *  so the next turn ships it back and the model sees one numbering scheme. */
export function foldAliases(
  wire: Readonly<Record<string, { track_id: string; start_ms?: number; end_ms?: number }>>
): Record<string, ChatAliasEntry> {
  const out: Record<string, ChatAliasEntry> = {}
  for (const [k, v] of Object.entries(wire)) {
    const entry: ChatAliasEntry = { trackId: v.track_id }
    if (typeof v.start_ms === "number") (entry as { startMs?: number }).startMs = v.start_ms
    if (typeof v.end_ms === "number") (entry as { endMs?: number }).endMs = v.end_ms
    out[k] = entry
  }
  return out
}
