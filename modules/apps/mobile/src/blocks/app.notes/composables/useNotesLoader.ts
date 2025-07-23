import { Note, Track } from '@lectorium/dal/models'
import { IRepository } from '@lectorium/dal/index'
import { useLogger } from '@lectorium/mobile/core'

export type Options = {
  notesRepository: IRepository<Note>
  tracksRepository: IRepository<Track>
}

export function useNotesLoader(options: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'notes'})

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

      // Get unique languages from block ids
      // TODO: we need better a way to extract language from block ids
      const langs = [...new Set(note.blocks.map(block => block.slice(0, 2)))]

      // Add note to result
      result.push({
        id: note._id,
        trackId: note.trackId,
        text: note.text,
        blocks: note.blocks,
        language: langs.length > 0 ? langs[0] : '',
        trackAuthor: track.author,
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