import { Author, Language, Note, Source, Track, Transcript, TranscriptBlock } from '@lectorium/dal/models'
import { useTranscriptStore } from './useTranscriptStore'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { TranscriptBlocksGroupView, TranscriptBlockView, TranscriptParagraphBlockView, TranscriptSentenceBlockView, TranscriptVerseTextBlockView, TranscriptVerseTranslationBlockView } from '../models'
import { useSpeakerIcons } from './useSpeakerIcons'
import { IRepository } from '@lectorium/dal/index'
import { createSharedComposable } from '@vueuse/core'
import { mapReference } from '@blocks/app.tracks'

export type Options = {
  authorsRepository: IRepository<Author>
  tracksRepository: IRepository<Track>
  languagesRepository: IRepository<Language>
  notesRepository: IRepository<Note>
  sourcesRepository: IRepository<Source>
}

export const useTranscriptLoader = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */
 
  const transcriptStore = useTranscriptStore()

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: Options) {
    options = o
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load(trackId: string) {
    if (!options) { throw new Error('useTranscriptLoader is not initialized. Call init(options) first.') }
    transcriptStore.isLoading = true
    try {
      const track = await options.tracksRepository.getOne(trackId)
      const author = await options.authorsRepository.getOne('author::' + track.author)
      if (!track) { return }

      transcriptStore.title = track.title
      transcriptStore.author = author ? author.fullName : {}

      // get all available transcript languages
      const languages = Object.keys(track.transcripts)
      const transcriptFiles = await getTranscriptFiles(
        languages.map(lang => ({ lang, path: track.transcripts[lang].path }))
      )

      // load notes
      // TODO: it loads only 1000 notes only
      const notes = await options.notesRepository.getMany({ selector: { trackId }, limit: 1000 })
      const bookmarkedTimings = notes.flatMap(note => ({ timeStart: note.timeStart, timeEnd: note.timeEnd }))
      
      // Speaker icons
      const speakerIcons = useSpeakerIcons(languages)

      // normalize and enrich transcript blocks:
      // - normalize start time of the blocks
      // - enrich blocks speaker information: icon, language
      // - enrich blocks with highlighted state
      let sentences: TranscriptBlockView[] = []
      for (const transcriptFile of transcriptFiles) {
        const { lang, transcript } = transcriptFile

        // Map all transcript blocks into transcript block views
        const blockViews = await Promise.all(
          transcript.blocks.map(x => mapTranscriptBlock(x, lang))
        )

        // Filter out blocks we didn't recognize
        const knownBlockViews = blockViews.filter(x => x !== undefined)

        // enrich blocks with additional information
        const enrichedBlocks = knownBlockViews
          .map(block => ({ 
            block: block, 
            language: lang, 
            speaker: lang,
            bookmarked: block && bookmarkedTimings.some(timing =>
              block.start >= timing.timeStart && block.end <= timing.timeEnd
            ), 
            selected: false,
            icon: speakerIcons[lang]
          }))
        
        // add the enriched blocks to the final sentences array
        //@ts-ignore
        sentences.push(...enrichedBlocks)
      }
      
      // sort sentences by start time, because there may be sentences of
      // different languages and they are not in the correct order, because
      // they are loaded from different files
      sentences = sentences.sort((a, b) => {
        if (a.block.start < b.block.start) return -1
        if (a.block.start > b.block.start) return 1
        return 0
      })

      const sentencesOnly = sentences.filter(x => x.block.type !== 'paragraph')
      if (sentencesOnly.length > 0) { sentencesOnly[0].block.start = 0 }
      for (let i = 0; i < sentencesOnly.length - 1; i++) {
        const currentSentence = sentencesOnly[i]
        const nextSentence = sentencesOnly[i + 1]
        currentSentence.block.end = nextSentence.block.start
      }

      // convert transcript to sections
      const paragraphs: TranscriptBlocksGroupView[] = []
      let lastParagraph: TranscriptBlockView[] = []
      const sentencesLength: Record<string, number> = 
        Object.fromEntries(languages.map(lang => [lang, 0]))

      for (const sentence of sentences) {
        if (
          Object.values(sentencesLength).some(value => value > 512) || 
          (
            sentence.block.type === 'sentence' && 
            lastParagraph && lastParagraph.length > 0 && 
            lastParagraph[0].block.type === 'verse:text' &&
            lastParagraph[0].block.text.length > 1
          )
        ) {
          paragraphs.push({ blocks: lastParagraph })
          lastParagraph = []
          Object.keys(sentencesLength).forEach(key => { sentencesLength[key] = 0 })
        }
        if (sentence.block.type !== 'paragraph') {
          lastParagraph.push({ ...sentence, })
          if (sentence.block.type === 'sentence') {
            sentencesLength[sentence.language] += sentence.block.text.length
          }
        }
      }
      if (lastParagraph.length > 0) {
        paragraphs.push({ blocks: lastParagraph })
      }

      // Set paragraphs
      transcriptStore.transcript = paragraphs

      const originalLanguage = 
        track.languages
          .find(x => x.source === 'track' && x.type === 'original')
          ?.language || track.languages[0].language || 'en'


      // Allow to select multiple languages if there several
      // original languges in the track
      transcriptStore.allowMultipleLanguages = track.languages
        .filter(x => x.type === 'original')
        .length > 1

      const languageItems = await options.languagesRepository.getMany({
        selector: { code : { $in: languages } },
      })
      transcriptStore.availableLanguages = languageItems.map((lang) => ({
        code: lang.code,
        name: lang.fullName,
        icon: lang.icon,
      })) 

      // Set active language
      transcriptStore.activeLanguages = [originalLanguage]
    } finally {
      transcriptStore.isLoading = false
    }
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

  async function mapTranscriptBlock(
    block: TranscriptBlock,
    language: string,
  ): Promise<    
    | TranscriptParagraphBlockView
    | TranscriptSentenceBlockView
    | TranscriptVerseTextBlockView 
    | TranscriptVerseTranslationBlockView
    | undefined
  > {
    if (!options) { throw new Error('useTranscriptLoader is not initialized. Call init(options) first.') }

    if (block.type === 'paragraph') { return block }
    else if (block.type === 'sentence') {
      const referenceView = block.reference 
        ? await mapReference(block.reference, language) 
        : block.reference
      return { ...block, reference: referenceView }
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