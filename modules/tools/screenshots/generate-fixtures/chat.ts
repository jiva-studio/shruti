/**
 * Demo chat sessions for the `03_chat` (soul Q&A, verse + citation cards) and
 * `07_media` (Prabhupāda remembrance, MediaCard) screenshots.
 *
 * The content is plain per-locale JSON under `chat-demo/`. The chat ANSWERS in
 * the UI language (the app translates), so each locale carries its own prose,
 * verse translation and citation snippet; the cited LECTURE is a real catalog
 * track, so a non-content UI locale cites its collapsed track (uk→ru track,
 * sr→en track) with the catalog title kept verbatim. `sr-cyrl.json` is
 * generated from `sr-latn.json` with the canonical Serbian transliterator
 * (scripts/gen-sr-cyrl) — don't hand-edit it.
 */
import type { ChatVerseBody, ChatCiteSnippet, MediaPayload } from "@lib/domain/chatMessage.js"
import { contentLanguageFor } from "../config.js"
import en from "./chat-demo/en.json"
import ru from "./chat-demo/ru.json"
import uk from "./chat-demo/uk.json"
import srLatn from "./chat-demo/sr-latn.json"
import srCyrl from "./chat-demo/sr-cyrl.json"

/** Stable session ids opened by the scenarios via the debug bridge. */
export const DEMO_SESSION_ID = "chat_demo_soul"
export const DEMO_MEDIA_SESSION_ID = "chat_demo_remembrance"

export interface ChatFixtureMessage {
  readonly id: string
  readonly role: "user" | "assistant"
  /** Raw markdown with inline `[verse:…]` / `[cite:…]` / `[media:…]` /
   *  `[followup:…]` markers — same code path the live chat takes. */
  readonly content: string
  readonly verses?: Record<string, ChatVerseBody>
  readonly cites?: Record<string, ChatCiteSnippet>
  readonly media?: Record<string, MediaPayload>
}

export interface ChatFixture {
  readonly sessionTitle: string
  readonly messages: readonly ChatFixtureMessage[]
}

interface ChatDemo {
  readonly soul: ChatFixture
  readonly media: ChatFixture
}

const DEMO = { ru, en, uk, "sr-Latn": srLatn, "sr-Cyrl": srCyrl } as unknown as Record<string, ChatDemo>

/** Demo for a UI locale, falling back to the content language (uk→ru, sr→en)
 *  for any locale without its own bundle. */
function demoFor(locale: string): ChatDemo {
  return DEMO[locale] ?? (contentLanguageFor(locale) === "ru" ? DEMO.ru! : DEMO.en!)
}

export function chatFixtureFor(locale: string): ChatFixture {
  return demoFor(locale).soul
}

export function mediaChatFixtureFor(locale: string): ChatFixture {
  return demoFor(locale).media
}
