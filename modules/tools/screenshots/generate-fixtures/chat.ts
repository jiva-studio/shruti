/**
 * Fixture content for the `03_chat` screenshot — one chat session with
 * a "What is the soul?" Q&A. The assistant answer carries a verse
 * marker (BG 2.20) and a citation marker so the screenshot showcases the
 * richest chat-bubble UI the app can render.
 *
 * The session id is fixed (`chat_demo_soul`) so the scenario can open the
 * session via the debug bridge — see scenarios.ts `DEMO_CHAT_SESSION_ID`.
 *
 * IMPORTANT: the live app receives the verse / cite bodies over SSE and
 * persists them on the message's `meta` envelope (`data.verses`,
 * `data.cites`); the renderer reads those maps off the message
 * (`message.verses["sourceId|tokens"]`, `message.cites["trackId|start-end"]`)
 * and shows the small chip only when the body is absent. So the fixture
 * carries those maps per message and seedChat() writes them into `meta` —
 * the old global localStorage LRU caches are no longer read.
 */
import type { ChatVerseBody, ChatCiteSnippet } from "@lib/domain/chatMessage.js"

export const DEMO_SESSION_ID = "chat_demo_soul"

export interface ChatFixtureMessage {
  /** ID is supplied here (not generated) so the assistant message
   *  always lands after the user one even when both share the same
   *  `created_at` second. */
  readonly id: string
  readonly role: "user" | "assistant"
  /** Raw markdown with inline `[verse:…]` / `[cite:…]` / `[followup:…]`
   *  markers. Parsed by useMarkerParser at render time — same code
   *  path the live chat takes after persisting a streamed reply. */
  readonly content: string
  /** Verse bodies, keyed `${sourceId}|${tokens}` — the persisted form of
   *  the server's `verse_payload` SSE event. */
  readonly verses?: Record<string, ChatVerseBody>
  /** Citation transcript snippets, keyed `${trackId}|${startMs}-${endMs}` —
   *  the persisted form of the server's `cite_transcript` SSE event. */
  readonly cites?: Record<string, ChatCiteSnippet>
}

export interface ChatFixture {
  readonly sessionTitle: string
  readonly messages: readonly ChatFixtureMessage[]
}

/**
 * Body for the `[verse:source_dsicuBsFvinZ/2.20|…]` marker (BG 2.20).
 * Canonical text from the catalog
 * (`mcp__lectorium__library_verse_get source_dsicuBsFvinZ tokens=2.20`),
 * frozen so the screenshot is reproducible even if the edition drifts.
 */
const VERSE_BG_220: ChatVerseBody = {
  addrLabel: "BG 2.20",
  sanskrit: [
    "न जायते म्रियते वा कदाचि-",
    "न्नायं भूत्वा भविता वा न भूयः ।",
    "अजो नित्यः शाश्वतोऽयं पुराणो",
    "न हन्यते हन्यमाने शरीरे ॥२०॥",
  ].join("\n"),
  transliteration: [
    "na jāyate mriyate vā kadācin",
    "nāyaṁ bhūtvā bhavitā vā na bhūyaḥ",
    "ajo nityaḥ śāśvato 'yaṁ purāṇo",
    "na hanyate hanyamāne śarīre",
  ].join("\n"),
  translation: {
    en: "For the soul there is neither birth nor death at any time. He has not come into being, does not come into being, and will not come into being. He is unborn, eternal, ever-existing and primeval. He is not slain when the body is slain.",
    ru: "Душа не рождается и не умирает. Она никогда не возникала, не возникает и не возникнет. Она нерожденная, вечная, всегда существующая и изначальная. Она не гибнет, когда погибает тело.",
  },
}

/**
 * Russian fixture. The assistant cites a real ru-locale lecture from
 * the screenshot playlist (`track_k1a4Ah1CZ8ac`, "Аромат души") so the
 * citation card opens onto a track that actually exists in the stubbed
 * catalog.
 */
const RU: ChatFixture = {
  sessionTitle: "Что такое душа?",
  messages: [
    {
      id: "msg_demo_soul_user",
      role: "user",
      content: "Что такое душа?",
    },
    {
      id: "msg_demo_soul_assistant",
      role: "assistant",
      content: [
        "Душа (на санскрите *атма*) — это вечная духовная искра, истинное «я», отличное от материального тела. В «Бхагавад-гите» Господь Кришна объясняет это Арджуне:",
        "",
        "[verse:source_dsicuBsFvinZ/2.20|БГ 2.20]",
        "",
        "Тело меняется — детство, юность, старость, смерть, — но сама душа остаётся неизменной. Подробнее об этом Шрила Прабхупада рассказывает в лекции [cite:track_k1a4Ah1CZ8ac@0-300000|Аромат души]",
        "",
        "[followup:Что происходит с душой после смерти?]",
        "[followup:Чем душа отличается от ума?]",
      ].join("\n"),
      verses: { "source_dsicuBsFvinZ|2.20": VERSE_BG_220 },
      cites: {
        "track_k1a4Ah1CZ8ac|0-300000": {
          text: "Верховный Господь сказал: ведя ученые речи, ты сокрушаешься о том, что недостойно скорби. Мудрые люди не скорбят ни о мертвых, ни о живых.",
        },
      },
    },
  ],
}

/**
 * English fixture. Cites `track_0dRAV1Swc3ak` ("Prahlāda Mahārāja's
 * Instruction to His Classmates") from the en playlist — a lecture
 * where Prabhupāda discusses the soul at length.
 */
const EN: ChatFixture = {
  sessionTitle: "What is the soul?",
  messages: [
    {
      id: "msg_demo_soul_user",
      role: "user",
      content: "What is the soul?",
    },
    {
      id: "msg_demo_soul_assistant",
      role: "assistant",
      content: [
        "The soul (Sanskrit *ātmā*) is the eternal spiritual spark, the true self, distinct from the material body. In the *Bhagavad-gītā*, Lord Kṛṣṇa explains it to Arjuna:",
        "",
        "[verse:source_dsicuBsFvinZ/2.20|BG 2.20]",
        "",
        "The body changes — childhood, youth, old age, death — but the soul itself remains unchanged. Śrīla Prabhupāda elaborates on this in his lecture [cite:track_0dRAV1Swc3ak@0-300000|Prahlāda on the Eternal Soul]",
        "",
        "[followup:What happens to the soul after death?]",
        "[followup:How is the soul different from the mind?]",
      ].join("\n"),
      verses: { "source_dsicuBsFvinZ|2.20": VERSE_BG_220 },
      cites: {
        "track_0dRAV1Swc3ak|0-300000": {
          text: "This instruction of Prahlāda Mahārāja to his class fellows we are discussing for the last few days. Everyone is engaged in a particular type of occupational duty, never mind what is that occupation.",
        },
      },
    },
  ],
}

export function chatFixtureFor(locale: string): ChatFixture {
  return locale === "ru" ? RU : EN
}
