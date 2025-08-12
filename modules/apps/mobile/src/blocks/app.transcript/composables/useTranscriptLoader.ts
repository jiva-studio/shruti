import { Author, Language, Note, Source, Track, Transcript, TranscriptBlock } from '@shruti/dal/models'
import { useTranscriptStore } from './useTranscriptStore'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { TranscriptBlocksGroupView, TranscriptBlockView, TranscriptParagraphBlockView, TranscriptSentenceBlockView, TranscriptVerseTextBlockView, TranscriptVerseTranslationBlockView } from '../models'
import { useSpeakerIcons } from './useSpeakerIcons'
import { IRepository } from '@shruti/dal/index'
import { createSharedComposable } from '@vueuse/core'
import { mapReference } from '@blocks/app.tracks'

export type Options = {
  notesRepository: IRepository<Note>
  tracksRepository: IRepository<Track>
  sourcesRepository: IRepository<Source>
  authorsRepository: IRepository<Author>
  languagesRepository: IRepository<Language>
}

export const useTranscriptLoader = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */
 
  const store = useTranscriptStore()

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: Options) {
    options = o
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load(
    trackId: string,
    languages?: string[],
  ) {
    if (!options) { throw new Error('useTranscriptLoader is not initialized.') }
    try {
      store.isLoading = true
      
      // load related objects
      const [ track, notes ] = await Promise.all([
        await options.tracksRepository.getOne(trackId),
        await options.notesRepository.getMany({ selector: { trackId }, limit: 1000 })
      ])
      const author = await options.authorsRepository.getOne('author::' + track.author)

      // set meta
      store.title  = track.title
      store.author = author.fullName
      
      // load transcript and languages
      const [allowMultipleLangs, originalLang, allLanguages] = loadLanguages(track)
      store.transcript = await loadBlockViews(track, languages || [originalLang], notes)
      store.activeLanguages = languages || [originalLang]
      store.allowMultipleLanguages = allowMultipleLangs

      const languageItems = await options.languagesRepository.getMany({
        selector: { code : { $in: allLanguages } },
      })
      store.availableLanguages = languageItems.map((lang) => ({
        code: lang.code,
        name: lang.fullName,
        icon: lang.icon,
      })) 


    } finally {
      store.isLoading = false
    }
  }

  function loadLanguages(
    track: Track
  ): [boolean, string, string[]] {
    const allLanguages = Object.keys(track.transcripts)
    const originalLang = track.languages
      .find(x => x.source === 'track' && x.type === 'original')?.language 
        || track.languages[0].language 
        || 'en'

      // Allow to select multiple languages if there several
      // original languges in the track
      const allowMultipleLangs = track.languages
        .filter(x => x.type === 'original')
        .length > 1

      return [allowMultipleLangs, originalLang, allLanguages]
  }

  async function loadBlockViews(
    track: Track,
    languages: string[],
    notes: Note[]
  ) {
    // get all available transcript languages
    const info  = track.transcripts
    const paths = languages.map(lang => ({ lang, path: info[lang].path }))
    const files = await getTranscriptFiles(paths)

    // get additional meta
    const speakerIcons = useSpeakerIcons(languages)
    const bookmarkedTimings = notes.flatMap(note => ({ 
      timeStart: note.timeStart, 
      timeEnd: note.timeEnd 
    }))
    
    // convert transcript blocks into block views
    let views: TranscriptBlockView[] = []
    for (const { lang, transcript } of files) {
      const blockViews = (await Promise.all(
        transcript.blocks.map((x, idx) => mapTranscriptBlock({
          block: x, blockIdx: idx, transcript: transcript, language: lang
        }))
      ))
        .filter(x => x !== undefined && x.type !== 'paragraph')
        .map(block => ({ 
          block: block, 
          language: lang, 
          selected: false,
          icon: languages.length > 1 
            ? speakerIcons[lang] 
            : undefined,
          bookmarked: bookmarkedTimings
            .some(bookmark => 
              block!.start >= bookmark.timeStart && 
              block!.end   <= bookmark.timeEnd
            ),
        })) as TranscriptBlockView[]
      views.push(...blockViews)
    }
    
    // sort blocks by start time, because there may be blocks of
    // different languages and they are not in the correct order, because
    // they are loaded from different files
    views = views.sort((a, b) => {
      if (a.block.start < b.block.start) return -1
      if (a.block.start > b.block.start) return 1
      return 0
    })

    // Remove time gaps between blocks. Set end time of current bloct
    // to the beggining of the next block.
    if (views.length > 0) { views[0].block.start = 0 }
    for (let i = 0; i < views.length - 1; i++) {
      const current = views[i]
      const next    = views[i + 1]
      current.block.end = next.block.start
    }

    // convert transcript to sections
    let lastGroup: TranscriptBlockView[] = []
    const groups: TranscriptBlocksGroupView[] = []
    const blockTextLengths: Record<string, number> = 
      Object.fromEntries(languages.map(lang => [lang, 0]))

    for (const view of views) {
      const isGroupTooLong = blockTextLengths[view.language] > 512
      const isSpeakerTheSame = 
        view.block.type === 'sentence'
        && view.block.speaker 
        && view.block.speakerChanged === false 
      
      if (isGroupTooLong && !isSpeakerTheSame) {
        groups.push({ blocks: lastGroup })
        languages.forEach(lang => { blockTextLengths[lang] = 0 })
        lastGroup = []
      }

      if (view.block.type === 'sentence' || view.block.type === 'verse:text') {
        blockTextLengths[view.language] += view.block.text.length
      }

      lastGroup.push({ ...view })
    }

    if (lastGroup.length > 0) {
      groups.push({ blocks: lastGroup })
    }

    return groups 
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Private                                  */
  /* -------------------------------------------------------------------------- */

  async function getTranscriptFiles(files: {
    lang: string, path: string
  }[]): Promise<{ 
    lang: string, 
    transcript: Transcript 
  }[]> {
    return await Promise.all(
      files.map(async file => ({
        lang: file.lang,
        transcript: await getTransciptFile(file.path)
      }))
    )
  }

  async function getTransciptFile(
    path: string
  ): Promise<Transcript> {
    const file = await Filesystem.readFile({
      path: path,
      directory: Directory.External,
      encoding: Encoding.UTF8,
    })
    return JSON.parse(file.data as string) as Transcript
  }

  async function mapTranscriptBlock(data: {
    block: TranscriptBlock,
    blockIdx: number,
    transcript: Transcript,
    language: string,
  }): Promise<    
    | TranscriptParagraphBlockView
    | TranscriptSentenceBlockView
    | TranscriptVerseTextBlockView 
    | TranscriptVerseTranslationBlockView
    | undefined
  > {
    if (!options) { throw new Error('useTranscriptLoader is not initialized. Call init(options) first.') }
    const { block, language, transcript, blockIdx } = data

    if (block.type === 'paragraph') { return block }
    else if (block.type === 'sentence') {
      const prevBlock = transcript.blocks[blockIdx-1]
      const speakerChanged = prevBlock 
        ? prevBlock.type === 'sentence' && prevBlock.speaker !== block.speaker
        : false
      const referenceView = block.reference 
        ? await mapReference(block.reference, language) 
        : block.reference
      return { ...block, speakerChanged, reference: referenceView }
    } else if (block.type === 'verse:text') {
      const referenceView = block.reference 
        ? await mapReference(block.reference, language) 
        : block.reference
      return { ...block, reference: referenceView }
    } else if (block.type === 'verse:translation') {
      return block
    }

    return undefined
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, load }
})