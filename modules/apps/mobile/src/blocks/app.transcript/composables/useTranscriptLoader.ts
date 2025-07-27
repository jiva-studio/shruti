import { Author, Language, Note, Track, Transcript } from '@lectorium/dal/models'
import { useTranscriptStore } from './useTranscriptStore'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { TranscriptParagraph, TranscriptSentence } from '../models'
import { useSpeakerIcons } from './useSpeakerIcons'
import { IRepository } from '@lectorium/dal/index'
import { createSharedComposable } from '@vueuse/core'

export type Options = {
  authorsRepository: IRepository<Author>
  tracksRepository: IRepository<Track>
  languagesRepository: IRepository<Language>
  notesRepository: IRepository<Note>
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
      const highlightedSentences = notes.flatMap(x => x.blocks)
      
      // 
      const speakerIcons = useSpeakerIcons(languages)

      // normalize and enrich transcript blocks:
      // - normalize start time of the blocks
      // - enrich blocks speaker information: icon, language
      // - enrich blocks with highlighted state
      let sentences: TranscriptSentence[] = []
      for (const transcriptFile of transcriptFiles) {
        const { lang, transcript } = transcriptFile
        
        // enrich blocks with additional information
        const enrichedBlocks = transcript.blocks
          .map((block, index) => ({ 
            ...block, 
            id: `${lang}${index}`,
            sequentalId: 0,
            language: lang, 
            speaker: lang,
            highlighted: highlightedSentences.includes(`${lang}${index}`),
            selected: false,
            icon: speakerIcons[lang]
          }))
        
        // add the enriched blocks to the final sentences array
        sentences.push(...enrichedBlocks)
      }

      // sort sentences by start time, because there may be sentences of
      // different languages and they are not in the correct order, because
      // they are loaded from different files
      sentences = sentences.sort((a, b) => {
        if (a.start < b.start) return -1
        if (a.start > b.start) return 1
        return 0
      })

      const sentencesOnly = sentences.filter(x => x.type !== 'paragraph')
      if (sentencesOnly.length > 0) { sentencesOnly[0].start = 0 }
      for (let i = 0; i < sentencesOnly.length - 1; i++) {
        const currentSentence = sentencesOnly[i]
        const nextSentence = sentencesOnly[i + 1]
        currentSentence.end = nextSentence.start
      }

      // set sequentalId for sentence
      sentences.forEach((v, i) => v.sequentalId = i)

      // convert transcript to sections
      const paragraphs: TranscriptParagraph[] = []
      let lastParagraph: TranscriptSentence[] = []
      const sentencesLength: Record<string, number> = 
        Object.fromEntries(languages.map(lang => [lang, 0]))

      for (const sentence of sentences) {
        if (Object.values(sentencesLength).some(value => value > 512)) {
          paragraphs.push({ sentences: lastParagraph })
          lastParagraph = []
          Object.keys(sentencesLength).forEach(key => { sentencesLength[key] = 0 })
        }
        if (sentence.type !== 'paragraph') {
          lastParagraph.push({ ...sentence, })
          sentencesLength[sentence.language] += sentence.text.length
        }
      }
      if (lastParagraph.length > 0) {
        paragraphs.push({ sentences: lastParagraph })
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

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, load }
})