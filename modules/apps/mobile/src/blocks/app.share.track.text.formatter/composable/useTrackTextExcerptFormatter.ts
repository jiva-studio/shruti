import { mapAuthorFullNameById, mapReference, mapTrackDate, mapTrackTitle } from '@blocks/app.tracks'
import { IRepository } from '@lectorium/dal'
import { Track } from '@lectorium/dal'
import { useTimeFormatter } from '@lectorium/mobile/core'

export type InitOptions = {
  tracksRepository: IRepository<Track>
}

export type FormatTrackTextExcerptRequest = {
  trackId: string
  language: string
  text: string
  timeStart?: number
  timeEnd?: number
}

export function useTrackTextExcerptFormatter(
  options: InitOptions
) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const toTime = useTimeFormatter().fromSeconds

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function format(
    request: FormatTrackTextExcerptRequest
  ) : Promise<string> {
    const track  = await options.tracksRepository.getOne(request.trackId)

    const qutationSign = '❞'
    const delimiter    = '•'

    const safeText  = request.text.replace(/<[^>]*>/g, '')
    const author    = await mapAuthorFullNameById(track.author, request.language)
    const title     = delimiter + ' ' + mapTrackTitle(track.title, request.language)
    const date      = track.date ? delimiter + ' ' + mapTrackDate(track.date) : '' // TODO: use locale

    const reference = (track.references && track.references.length > 0) ? delimiter + ' ' + await mapReference(track.references[0], request.language) : ''

    const timeRangeText = (
      request.timeStart && request.timeEnd
        ? `[${toTime(request.timeStart)}-${toTime(request.timeEnd)}]`
        : ''
    )
    const formattedText = (
      `${qutationSign} ${safeText}\n\n${author} ${date} ${reference} ${title} ${timeRangeText}`.trim()
    )

    return formattedText
  }

  return { format }
}