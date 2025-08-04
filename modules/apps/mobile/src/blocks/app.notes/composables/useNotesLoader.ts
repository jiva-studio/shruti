import { Note, Track } from '@shruti/dal/models'
import { IRepository } from '@shruti/dal/index'
import { useLanguageDetector, useLogger } from '@shruti/mobile/core'

export type Options = {
  notesRepository: IRepository<Note>
  tracksRepository: IRepository<Track>
}

export function useNotesLoader(options: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'notes'})
  const languageDetector = useLanguageDetector()

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function load() {
    const result = []
    const notes = await options.notesRepository.getMany({
      selector: { 
        type: 'note', 
        createdAt: { $gte: null } 
      },
      sort: ['createdAt'],
      limit: 1000 // TODO: add pagination
    })

    const relatedTracks = await options.tracksRepository.getMany({
      selector: { _id: { $in: notes.map(note => note.trackId) } },
      limit: 1000 // TODO: add pagination
    })

    for (const note of notes) {      
      const track = relatedTracks.find(t => t._id === note.trackId)
      if (!track) {
        logger.error(`Track not found for note ${note._id} with trackId ${note.trackId}`)
        continue
      }

      // Add note to result
      result.push({
        id: note._id,
        trackId: note.trackId,
        text: note.text,
        language: languageDetector.detect(note.text),
        trackAuthor: track.author,
        timeStart: note.timeStart,
        timeEnd: note.timeEnd,
        trackTitle: track.title['ru'], // TODO: lang
      })
    }

    return result
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { load }
}