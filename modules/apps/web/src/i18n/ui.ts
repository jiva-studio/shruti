export const languages = { ru: 'Русский', en: 'English' } as const
export type Lang = keyof typeof languages
export const defaultLang: Lang = 'ru'

export const STORE = {
  appStore: 'https://apps.apple.com/app/id6745510353',
  googlePlay: 'https://play.google.com/store/apps/details?id=studio.jiva.shruti',
  vk: 'https://vk.com/akd.studio',
  telegram: 'https://t.me/shrutiapp',
  email: 'support@akdasa.studio',
}

export const ui = {
  ru: {
    'nav.about': 'О приложении',
    'nav.features': 'Возможности',
    'nav.lectures': 'Лекции',
    'nav.chat': 'Спросить Садху',
    'nav.faq': 'Вопросы',
    'nav.download': 'Скачать',

    'hero.title': 'Слушай Садху',
    'hero.subtitle': 'Вся ведическая мудрость в одном приложении. Лекции Шрилы Прабхупады.',
    'hero.lead':
      'Сложное — простыми словами: о душе, сознании, карме и смысле жизни. Слушайте по дороге, на прогулке или дома и возвращайтесь к самому важному, когда захотите.',
    'hero.qr': 'Наведите камеру, чтобы установить',

    'features.title': 'Возможности',
    'features.lead': 'Всё, чтобы изучать писания каждый день.',
    'feature.library.t': 'Большая библиотека лекций',
    'feature.library.d': 'Тысячи лекций по «Бхагавад-гите», «Шримад-Бхагаватам» и другим писаниям — всегда под рукой.',
    'feature.transcript.t': 'Текст рядом с аудио',
    'feature.transcript.d': 'Читайте и слушайте одновременно — транскрипт лекции с заголовками идёт вместе со звуком.',
    'feature.bookmarks.t': 'Закладки на важные мысли',
    'feature.bookmarks.d': 'Сохраняйте фрагменты, чтобы вернуться к ним позже, поделиться или собрать заметки.',
    'feature.search.t': 'Поиск по теме',
    'feature.search.d': 'Находите лекции по названию, источнику, автору, дате — как вам удобно.',
    'feature.offline.t': 'Слушайте без интернета',
    'feature.offline.d': 'Загружайте лекции и слушайте офлайн — в дороге и где угодно.',
    'feature.chat.t': 'Спросите Садху',
    'feature.chat.d': 'Задайте вопрос и получите понятный ответ со ссылками на конкретные лекции.',

    'chat.band.title': 'Спросите Садху — прямо сейчас',
    'chat.band.lead': 'Анонимно, без регистрации. Задайте вопрос о душе, карме или смысле жизни и получите ответ со ссылками на лекции.',
    'chat.band.cta': 'Открыть чат',

    'download.title': 'Установите приложение',
    'download.lead': 'Бесплатно. iPhone, iPad и Android.',

    'faq.title': 'Вопросы и ответы',

    'footer.tagline': 'Лекции по ведическим писаниям — слушайте и изучайте каждый день.',
    'footer.links': 'Разделы',
    'footer.follow': 'Мы в соцсетях',
    'footer.support': 'Поддержка',
    'footer.rights': 'Все права защищены.',
  },
  en: {
    'nav.about': 'About',
    'nav.features': 'Features',
    'nav.lectures': 'Lectures',
    'nav.chat': 'Ask Sadhu',
    'nav.faq': 'FAQ',
    'nav.download': 'Download',

    'hero.title': 'Shruti',
    'hero.subtitle': 'All Vedic wisdom in one app. Lectures of Srila Prabhupada.',
    'hero.lead':
      'Deep ideas in plain words — the soul, consciousness, karma and the meaning of life. Listen on your commute, on a walk or at home, and come back to what matters whenever you like.',
    'hero.qr': 'Point your camera to install',

    'features.title': 'Features',
    'features.lead': 'Everything you need to study the scriptures every day.',
    'feature.library.t': 'A large library of lectures',
    'feature.library.d': 'Thousands of lectures on the Bhagavad-gita, Srimad-Bhagavatam and other scriptures — always at hand.',
    'feature.transcript.t': 'Text alongside the audio',
    'feature.transcript.d': 'Read and listen at the same time — the lecture transcript with headings follows the sound.',
    'feature.bookmarks.t': 'Bookmark what matters',
    'feature.bookmarks.d': 'Save passages to return to later, share, or collect as notes.',
    'feature.search.t': 'Search by topic',
    'feature.search.d': 'Find lectures by title, source, author or date — however you like.',
    'feature.offline.t': 'Listen offline',
    'feature.offline.d': 'Download lectures and listen without an internet connection, anywhere.',
    'feature.chat.t': 'Ask Sadhu',
    'feature.chat.d': 'Ask a question and get a clear answer with links to the specific lectures.',

    'chat.band.title': 'Ask Sadhu — right now',
    'chat.band.lead': 'Anonymous, no sign-up. Ask about the soul, karma or the meaning of life and get an answer with links to lectures.',
    'chat.band.cta': 'Open the chat',

    'download.title': 'Get the app',
    'download.lead': 'Free. iPhone, iPad and Android.',

    'faq.title': 'Questions & answers',

    'footer.tagline': 'Lectures on the Vedic scriptures — listen and study every day.',
    'footer.links': 'Sections',
    'footer.follow': 'Follow us',
    'footer.support': 'Support',
    'footer.rights': 'All rights reserved.',
  },
} as const

export type UiKey = keyof (typeof ui)['ru']

export function useT(lang: Lang) {
  return (key: UiKey): string => (ui[lang] as Record<string, string>)[key] ?? ui.ru[key] ?? key
}

export const FAQ = {
  ru: [
    ['Сколько стоит приложение?', 'Базовые возможности бесплатны: слушайте лекции, читайте транскрипты, делайте закладки. Подписка PRO добавляет умную библиотеку и расширенные функции.'],
    ['Нужен ли интернет?', 'Нет. Загрузите лекции заранее и слушайте офлайн — в дороге, на прогулке, где угодно.'],
    ['На каких устройствах работает?', 'iPhone, iPad и Android. Скачайте в App Store или Google Play.'],
    ['Что такое «Спросить Садху»?', 'Это помощник, который ищет ответ по корпусу лекций и даёт понятный ответ со ссылками на конкретные записи.'],
  ],
  en: [
    ['How much does the app cost?', 'The basics are free: listen to lectures, read transcripts, bookmark passages. A PRO subscription adds the smart library and advanced features.'],
    ['Do I need an internet connection?', 'No. Download lectures in advance and listen offline — on your commute, on a walk, anywhere.'],
    ['Which devices are supported?', 'iPhone, iPad and Android. Get it on the App Store or Google Play.'],
    ['What is "Ask Sadhu"?', 'An assistant that searches the lecture corpus and gives a clear answer with links to the specific recordings.'],
  ],
} as const
