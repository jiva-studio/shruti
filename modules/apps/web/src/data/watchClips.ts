import type { ContentLang } from '../i18n/locales'

/** One clip in the "why listening matters" carousel. `id` is the media id in
 *  the corpus: the video is `public/media/<id>.mp4`, its poster `<id>.jpg`
 *  (resolved against the CDN media base by resolveMediaUrl). Clips are the
 *  "Following Śrīla Prabhupāda" excerpts curated for the theme of hearing;
 *  title + blurb are authored in the clip's own content language. */
export interface WatchClip {
  id: string
  title: string
  blurb: string
}

export const WATCH_CLIPS: Record<ContentLang, WatchClip[]> = {
  ru: [
    {
      id: 'fsp-8-ru-048',
      title: 'Слушать гуру — долг ученика',
      blurb: 'Прабхупада строго напомнил: самое важное — внимательно слушать хари-катху.',
    },
    {
      id: 'fsp-9-ru-022',
      title: 'Знание — по цепи парампары',
      blurb: 'Наставление нужно услышать и применить — и это по-настоящему работает.',
    },
    {
      id: 'fsp-3-ru-096',
      title: 'О Кришне расскажет преданный',
      blurb: 'Слушать стоит из верного источника — от того, кто внутри традиции.',
    },
    {
      id: 'fsp-8-ru-062',
      title: 'Простой и действенный метод',
      blurb: 'Стоит привязаться к слушанию и воспеванию — и сердце раскрывается.',
    },
    {
      id: 'fsp-6-ru-089',
      title: 'Наука о Боге',
      blurb: 'Услышанное святое имя — уже прямой контакт с Богом.',
    },
    {
      id: 'fsp-9-ru-064',
      title: 'Шраванам, киртанам',
      blurb: 'Слушание стоит первым в списке практик преданного служения.',
    },
    {
      id: 'fsp-10-ru-098',
      title: 'Сила святого имени',
      blurb: 'Даже одно имя Кришны уничтожает больше грехов, чем можно совершить.',
    },
  ],
  en: [
    {
      id: 'fsp-7-en-051-spk19',
      title: 'A connection, like a radio',
      blurb: 'Keep contact with the transcendental sound and you are connected directly.',
    },
    {
      id: 'fsp-6-en-102-spk61',
      title: 'He was talking to you',
      blurb: "A lecture that went straight to the heart — not to the crowd.",
    },
    {
      id: 'fsp-9-en-025-spk15',
      title: 'Know these books',
      blurb: "Don't just hear the words — understand what you are hearing.",
    },
    {
      id: 'fsp-6-en-071-spk11',
      title: 'The name is the substance',
      blurb: 'Sacred sound is non-different from the Lord — so hearing works.',
    },
    {
      id: 'fsp-8-en-101-spk30',
      title: 'It takes time',
      blurb: 'Understanding grows through steady, patient hearing — not in a minute.',
    },
    {
      id: 'fsp-6-en-069-spk11',
      title: 'The science of God',
      blurb: 'Accept the holy name and you associate with God immediately.',
    },
    {
      id: 'fsp-6-en-023-spk0',
      title: 'You give the class',
      blurb: 'The living tradition of hearing — and passing on the word.',
    },
  ],
}
