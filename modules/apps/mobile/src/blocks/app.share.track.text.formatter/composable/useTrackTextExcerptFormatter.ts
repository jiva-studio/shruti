import { IRepository } from '@shruti/dal/index'
import { Author, Track } from '@shruti/dal/models'
import { useTimeFormatter } from '@shruti/mobile/core'

export type InitOptions = {
  tracksRepository: IRepository<Track>
  authorsRepository: IRepository<Author>
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
    // fetch related data
    const track  = await options.tracksRepository.getOne(request.trackId)
    const author = await options.authorsRepository.getOne('author::' + track.author)

    // get related data
    const authorName = (
      author.fullName[request.language] || 
      author.fullName['en'] ||
      track.title[Object.keys(track.title)[0]]
    )
    const trackTitle = (
      track.title[request.language] || 
      track.title['en'] || 
      track.title[Object.keys(track.title)[0]]
    )
    const safeText = (
      request.text.replace(/<[^>]*>/g, '')
    )
    const trackInfoText = (
      `${authorName} – ${trackTitle}`
    )
    const timeRangeText = (
      request.timeStart && request.timeEnd
        ? `[${toTime(request.timeStart)}-${toTime(request.timeEnd)}]`
        : ''
    )
    const formattedText = (
      `${safeText}\n\n${trackInfoText} ${timeRangeText}`.trim()
    )

    return formattedText
  }

  return { format }
}