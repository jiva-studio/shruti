import { AudioSegmentRequest, AudioSegmentResponse } from '@lectorium/protocol/audio'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { IRepository } from '@lectorium/dal/index'
import { Author, Track } from '@lectorium/dal/models'
import { useTimeFormatter } from '@lectorium/mobile/core'
import { useTrackAudioExcerptStore } from './useTrackAudioExcerptStore'


export type TrackExcerptGenerationOptions = {
  url: string
  tracksRepository: IRepository<Track>
  authorsRepository: IRepository<Author>
}

export type GenerateTrackExcertRequest = {
  authToken: string
  trackId: string
  timeStart: number
  timeEnd: number
  audioType: string
  outputPath: string
}

export type GenerateTrackExcerptIdRequest = {
  trackId: string
  timeStart: number
  timeEnd: number
  audioType: string
  language: string
}

export type GenerateTrackExcertResponse = {
  path: string
}

export function useTrackAudioExcerptGenerator(
  options: TrackExcerptGenerationOptions
) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const toTime = useTimeFormatter().fromSeconds
  const store = useTrackAudioExcerptStore()

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Generates excerpt Id
   * @param request Request to generate Id
   * @returns String
   */
  async function getExcerptId(
    request: GenerateTrackExcerptIdRequest 
  ): Promise<string> {
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
    const timeRange = (
      `[${toTime(request.timeStart)}-${toTime(request.timeEnd)}]`
    )

    return `${authorName} – ${trackTitle} ${timeRange}.mp3`
      .replace(/[<>"\/\\|?*\x00-\x1F]/g, '_') // Replace invalid filename characters
      .replace(/\s+/g, ' ')                    // Normalize whitespace
      .trim()
  }


  /**
   * Generate rack audio excerpt
   * @param request Request to generate track excerpt
   * @returns Path there generated file was saved
   */
  async function generate(
    request: GenerateTrackExcertRequest
  ): Promise<GenerateTrackExcertResponse> {
    try {
      store.busy = true
      const payload: AudioSegmentRequest = {
        trackId: request.trackId,
        timeStart: request.timeStart,
        timeEnd: request.timeEnd,
        audioType: request.audioType
      }
      
      // make request to the service to generate excerpt
      const response = await fetch(
        options.url, 
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${request.authToken}`,
          },
          body: JSON.stringify(payload)
        }
      )

      // get response
      const responsePayload = await response.json() as AudioSegmentResponse

      // download track excerpt
      const res = await Filesystem.downloadFile({
        url: responsePayload.signedUrl,
        path: request.outputPath,
        directory: Directory.Cache,
        recursive: true
      })

      // validate response
      if (!res.path) { throw new Error('Unable to download and save file')}
      
      // all done
      return { path: res.path }
    } finally {
      store.busy = false
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { getExcerptId, generate }


}