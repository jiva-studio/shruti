import { Transcript } from '@lectorium/dal/models'
import { useTranscriptStore } from './useTranscriptStore'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { TranscriptParagraph, TranscriptSentence } from '../models'
import { useSpeakerIcons } from './useSpeakerIcons'
import { LanguagesService, NotesService, TracksService } from '@lectorium/dal/index'

export type Options = {
  tracksService: TracksService
  languagesService: LanguagesService
  notesService: NotesService
}

export function useTranscriptLoader({
  tracksService,
  languagesService,
  notesService,
}: Options) {
  
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */
 
  const transcriptStore = useTranscriptStore()

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load(trackId: string) {
    const track = await tracksService.getOne(trackId)
    if (!track) return

    // get all available transcript languages
    const languages = Object.keys(track.transcripts)
    const transcriptFiles = await getTranscriptFiles(
      languages.map(lang => ({ lang, path: track.transcripts[lang].path }))
    )

    // 
    // TODO: it loads only 1000 notes only
    const notes = await notesService.getMany({ selector: { trackId }, limit: 1000 })
    const highlightedSentences = notes.flatMap(x => x.blocks)
    
    // 
    const speakerIcons = useSpeakerIcons(languages)

    // enrich the transcript blocks with the speaker information
    let sentences: TranscriptSentence[] = []
    for (const transcriptFile of transcriptFiles) {
      const { lang, transcript } = transcriptFile
      sentences.push(
        ...transcript.blocks
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
      )
    }

    // sort sentences by start time
    sentences = sentences.sort((a, b) => {
      if (a.start < b.start) return -1
      if (a.start > b.start) return 1
      return 0
    })

    // set sequentalId for sentence
    sentences.forEach((v, i) => v.sequentalId = i)

    // convert transcript to sections
    const paragraphs: TranscriptParagraph[] = []
    let sentencesAdded = 0
    let lastSentenceEndTime = 0
    let lastParagraph: TranscriptSentence[] = []

    for (const sentence of sentences) {
      if (sentence.type === 'paragraph' || sentencesAdded > 5) {
        paragraphs.push({ sentences: lastParagraph })
        lastParagraph = []
        sentencesAdded = 0
      }
      sentencesAdded++
      if (sentence.type !== 'paragraph') {
        lastParagraph.push({ 
          ...sentence, 
          ...{ start: lastSentenceEndTime } 
        })
        lastSentenceEndTime = sentence.end
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

    const languageItems = await languagesService.getMany({
      selector: { code : { $in: languages } },
    })
    transcriptStore.availableLanguages = languageItems.map((lang) => ({
      code: lang.code,
      name: lang.fullName,
      icon: lang.icon,
    })) 

    // Set active language
    transcriptStore.activeLanguages = [originalLanguage]
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

  return { load }
}