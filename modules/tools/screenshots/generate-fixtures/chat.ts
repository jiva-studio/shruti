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
import type { ChatVerseBody, ChatCiteSnippet, MediaPayload } from "@lib/domain/chatMessage.js"

export const DEMO_SESSION_ID = "chat_demo_soul"
/** Second demo session — a "remembrance video" Q&A whose assistant reply
 *  carries a `[media:…]` marker, so the screenshot showcases the MediaCard
 *  (video poster + play overlay + title). Opened by the `07_media`
 *  scenario via the debug bridge. */
export const DEMO_MEDIA_SESSION_ID = "chat_demo_remembrance"

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
  /** Media result payloads, keyed by the id used in this message's
   *  `[media:<id>]` marker(s) — the persisted form of the server's `media`
   *  SSE action. Undefined for messages with no media marker (most). */
  readonly media?: Record<string, MediaPayload>
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

/* -------------------------------------------------------------------------- */
/*                      Media remembrance session (07_media)                  */
/* -------------------------------------------------------------------------- */

/**
 * Shared media id for both locales. The marker `[media:<id>]`, the
 * `meta.data.media` key, and the intercepted `public/media/<id>.{mp4,jpg}`
 * path all derive from it. The clip is the "Following Śrīla Prabhupāda"
 * (DVD 7) remembrance of Gopalasyapriya dasi: at a cold evening darshan in
 * Māyāpur, Śrīla Prabhupāda noticed her thin cloth, asked "Are you all
 * right?", and instructed that the women devotees' needs be looked after —
 * a moment of his personal care for a disciple. The same story exists in
 * EN and RU, so one poster frame (`fixtures/media/remembrance-poster.jpg`)
 * serves both screenshots.
 */
const DEMO_MEDIA_ID = "media_demo_remembrance"
const DEMO_MEDIA_URL = `public/media/${DEMO_MEDIA_ID}.mp4`

/**
 * Russian remembrance fixture. The assistant intro frames the clip and the
 * `[media:…]` marker renders the video card (poster + play overlay + the
 * localized title / speaker). The transcript text rides the payload so the
 * card shows its expand chevron.
 */
const RU_MEDIA: ChatFixture = {
  sessionTitle: "Как Прабхупада заботился об учениках",
  messages: [
    {
      id: "msg_demo_remembrance_user",
      role: "user",
      content: "Как Шрила Прабхупада заботился о своих учениках?",
    },
    {
      id: "msg_demo_remembrance_assistant",
      role: "assistant",
      content: [
        "Ученики вспоминают Шрилу Прабхупаду как удивительно внимательного к их нуждам — он замечал самое малое и следил, чтобы никто не остался без заботы. Гопаласьяприя даси рассказывает о вечернем даршане в Маяпуре:",
        "",
        `[media:${DEMO_MEDIA_ID}|«У тебя всё в порядке?»]`,
        "",
        "Такими воспоминаниями наполнены фильмы «По стопам Шрилы Прабхупады»: ученики снова и снова рассказывают, как лично он заботился о них — в большом и в малом. Как сказала она сама: «Он действительно беспокоился о каждом из нас».",
        "",
        "[followup:Что ещё ученики вспоминают о Прабхупаде?]",
        "[followup:Покажи больше видео-воспоминаний]",
      ].join("\n"),
      media: {
        [DEMO_MEDIA_ID]: {
          id: DEMO_MEDIA_ID,
          url: DEMO_MEDIA_URL,
          type: "video",
          title: "«У тебя всё в порядке?»",
          speaker: "Гопаласьяприя даси",
          date: "1975",
          text:
            "Однажды вечером все матаджи пришли на даршан в переднем дворе. Вдруг наступила тишина, и Прабхупада посмотрел на меня и спросил: «У тебя всё в порядке?» Было прохладно, и он заметил: «Такая тонкая одежда — а есть ли у тебя тёплая одежда?» Потом он повернулся к Калаканте и сказал, что женщин нужно оберегать: «Они сами не попросят — спрашивай их раз в месяц и убедись, что у них есть всё необходимое». Многие преданные потом плакали: он был так внимателен и заботлив, он действительно беспокоился о каждом из нас.",
        },
      },
    },
  ],
}

/**
 * English remembrance fixture — the same Gopalasyapriya dasi / Māyāpur
 * story, in the source language of the DVD 7 footage.
 */
const EN_MEDIA: ChatFixture = {
  sessionTitle: "How Prabhupāda cared for his disciples",
  messages: [
    {
      id: "msg_demo_remembrance_user",
      role: "user",
      content: "How did Śrīla Prabhupāda care for his disciples?",
    },
    {
      id: "msg_demo_remembrance_assistant",
      role: "assistant",
      content: [
        "His disciples remember Śrīla Prabhupāda as endlessly attentive to their wellbeing — he noticed the smallest needs and made sure no one was overlooked. Gopalasyapriya dasi recalls an evening darshan in Māyāpur:",
        "",
        `[media:${DEMO_MEDIA_ID}|"Are you all right?"]`,
        "",
        "Memories like this fill the *Following Śrīla Prabhupāda* remembrances — again and again his disciples describe how personally he looked after them, in matters great and small. As she put it, \"he just really does care about all of us.\"",
        "",
        "[followup:What else do disciples remember about Prabhupāda?]",
        "[followup:Show me more remembrance videos]",
      ].join("\n"),
      media: {
        [DEMO_MEDIA_ID]: {
          id: DEMO_MEDIA_ID,
          url: DEMO_MEDIA_URL,
          type: "video",
          title: '"Are you all right?"',
          speaker: "Gopalasyapriya dasi",
          date: "1975",
          text:
            "One evening all the saṅkīrtana women had darshan out in the front yard. There was a lull, and he just looked at me and asked, \"Are you all right?\" He said it a few times — then, \"Such a thin cloth. Haven't you got a cloth?\" It was chilly and most devotees had chaddars. Then he told Kalakanta, right beside him, that the women must be looked after: \"They will not ask. You must ask them once a month and make sure they have everything they need.\" Afterwards some of the devotees were crying — he was so observant and concerned; he really does care about all of us.",
        },
      },
    },
  ],
}

export function mediaChatFixtureFor(locale: string): ChatFixture {
  return locale === "ru" ? RU_MEDIA : EN_MEDIA
}
