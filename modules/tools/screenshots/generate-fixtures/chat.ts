/**
 * Fixture content for the `05_chat` screenshot — one chat session with
 * a "What is the soul?" Q&A. The assistant answer carries a verse
 * marker (BG 2.20) and a citation chip so the screenshot showcases the
 * richest chat-bubble UI the app can render.
 *
 * The session id is fixed (`chat_demo_soul`) so the scenario can
 * navigate to a literal `/tabs/chat/chat_demo_soul` URL — see
 * scenarios.ts `DEMO_CHAT_SESSION_ID`.
 *
 * The companion `verseBodyCache` const is what capture.spec.ts writes
 * into Capacitor Preferences before boot — without that, the VerseCard
 * falls back to an inline chip placeholder instead of the full
 * sanskrit + IAST + translation block.
 */

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
}

export interface ChatFixture {
  readonly sessionTitle: string
  readonly messages: readonly ChatFixtureMessage[]
}

/**
 * Russian fixture. The assistant cites a real ru-locale lecture from
 * the screenshot playlist (`track_k1a4Ah1CZ8ac`, "Аромат души") so the
 * citation chip opens onto a track that actually exists in the
 * stubbed catalog.
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
        "Тело меняется — детство, юность, старость, смерть, — но сама душа остаётся неизменной. Подробнее об этом Шрила Прабхупада рассказывает в лекции [cite:track_k1a4Ah1CZ8ac@0-300000|Аромат души].",
        "",
        "[followup:Что происходит с душой после смерти?]",
        "[followup:Чем душа отличается от ума?]",
      ].join("\n"),
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
        "The body changes — childhood, youth, old age, death — but the soul itself remains unchanged. Śrīla Prabhupāda elaborates on this in his lecture [cite:track_0dRAV1Swc3ak@0-300000|Prahlāda on the Eternal Soul].",
        "",
        "[followup:What happens to the soul after death?]",
        "[followup:How is the soul different from the mind?]",
      ].join("\n"),
    },
  ],
}

export function chatFixtureFor(locale: string): ChatFixture {
  return locale === "ru" ? RU : EN
}

/** Capacitor Preferences cache entry — matches `StoredEntry` in
 *  useVerseBodyStore. `touchedAt` is filled in at preseed time so the
 *  LRU window is deterministic across runs. */
export interface VerseBodyEntry {
  readonly addrLabel: string
  readonly sanskrit: string
  readonly transliteration: string
  readonly translation: { readonly [lang: string]: string }
}

/**
 * Bodies for the `[verse:…]` markers referenced above. Without these
 * entries pre-seeded into Capacitor Preferences, VerseCard renders the
 * fallback chip — the screenshot would lose the sanskrit + IAST +
 * translation block that is the whole point of showing the chat bubble.
 *
 * The data here is the canonical text from the catalog
 * (`mcp__shruti__library_verse_get source_dsicuBsFvinZ tokens=2.20`).
 * Frozen at fixture-generation time so the screenshot is reproducible
 * even if the catalog edition drifts.
 */
export const verseBodyCache: Record<string, VerseBodyEntry> = {
  "source_dsicuBsFvinZ|2.20": {
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
  },
}
