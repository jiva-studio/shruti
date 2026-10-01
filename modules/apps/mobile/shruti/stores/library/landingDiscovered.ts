import type { DiscoveryHit, IDiscoveryClient } from "@lib/contracts"

const DEV_SAMPLE_HITS: readonly DiscoveryHit[] = [
  {
    item_id: 162,
    media_url:
      "https://audioveda.ru/uploads/store/56e352ff05389fb557fc8d4a0f59230c771ed7c637426706412dbdb971d9.mp3",
    page_url: "https://audioveda.ru/audios/7378",
    title: "Из чего складывается здоровье",
    author: "Василий Тушкин",
    language: "ru",
    recorded_on: "2013-12-29T00:00:00Z",
    references: ["SB 1.2.10"],
    collection: {
      id: 1,
      title: "Ведическая концепция здоровья",
      url: "https://audioveda.ru/unions/507",
      ordinal: 1,
      of: 3,
    },
    chunk:
      "00:06:41 Когда человек очень сильно болен, страдает, ему очень трудно сосредоточиться на чем-то, вообще, он даже на работу ходить не может, потому что тело нетрудоспособно...",
    score: 0.95,
  },
  {
    item_id: 9001,
    media_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    page_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Бхагавад-Гита как она есть (Обзор)",
    author: "Е.М. Чайтанья Чандра Чаран Прабху",
    language: "ru",
    recorded_on: "2020-05-15T00:00:00Z",
    references: ["BG 4.20"],
    chunk: "В этой лекции раскрываются основные аспекты 4-й главы Бхагавад-Гиты...",
    score: 0.9,
  },
  {
    item_id: 9002,
    media_url: "https://audioveda.ru/uploads/store/audio2.mp3",
    page_url: "https://audioveda.ru/audios/8100",
    title: "Смысл человеческой жизни",
    author: "Александр Хакимов",
    language: "ru",
    recorded_on: "2018-09-12T00:00:00Z",
    references: ["BG 2.13"],
    chunk: "В чем предназначение души и как преодолеть иллюзию материального существования...",
    score: 0.88,
  },
  {
    item_id: 9003,
    media_url: "https://audioveda.ru/uploads/store/audio3.mp3",
    page_url: "https://audioveda.ru/audios/9234",
    title: "Психология взаимоотношений",
    author: "Олег Гадецкий",
    language: "ru",
    recorded_on: "2019-03-21T00:00:00Z",
    chunk: "Законы гармонии и разрешения внутренних и внешних конфликтов...",
    score: 0.85,
  },
  {
    item_id: 9004,
    media_url: "https://audioveda.ru/uploads/store/audio4.mp3",
    page_url: "https://audioveda.ru/audios/5541",
    title: "Карма и законы судьбы",
    author: "Василий Тушкин",
    language: "ru",
    recorded_on: "2015-11-04T00:00:00Z",
    references: ["BG 3.9"],
    chunk:
      "Как формируется карма и каким образом бескорыстная деятельность освобождает от последствий...",
    score: 0.82,
  },
  {
    item_id: 9005,
    media_url: "https://www.youtube.com/watch?v=example5",
    page_url: "https://www.youtube.com/watch?v=example5",
    title: "Введение в ведическую философию",
    author: "Бхакти Вигьяна Госвами",
    language: "ru",
    recorded_on: "2021-10-10T00:00:00Z",
    chunk: "Фундаментальные основы ведического знания: три гуны, душа и Сверхдуша...",
    score: 0.8,
  },
]

export async function fetchDiscoveredHits(
  client: IDiscoveryClient | undefined,
  languages: readonly string[]
): Promise<readonly DiscoveryHit[]> {
  if (!client?.search) {
    return import.meta.env.DEV ? DEV_SAMPLE_HITS : []
  }
  try {
    const res = await client.search({ filter: { limit: 12, languages } })
    if (res.hits && res.hits.length > 0) return res.hits
    return import.meta.env.DEV ? DEV_SAMPLE_HITS : []
  } catch {
    return import.meta.env.DEV ? DEV_SAMPLE_HITS : []
  }
}
