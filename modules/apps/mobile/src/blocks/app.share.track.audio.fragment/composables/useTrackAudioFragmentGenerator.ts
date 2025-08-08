import { AudioSegmentRequest, AudioSegmentResponse } from '@lectorium/protocol/audio'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { IRepository } from '@lectorium/dal/index'
import { Author, Track } from '@lectorium/dal/models'
import { useTimeFormatter } from '@lectorium/mobile/core'
import { useTrackAudioFragmentStore } from './useTrackAudioFragmentStore'


export type TrackFragmentGenerationOptions = {
  url: string
  tracksRepository: IRepository<Track>
  authorsRepository: IRepository<Author>
}

export type GenerateTrackFragmentRequest = {
  filePath: string
  timeStart: number
  timeEnd: number
  outputPath: string
  authToken: string
}

export type GenerateTrackFragmentIdRequest = {
  trackId: string
  timeStart: number
  timeEnd: number
  audioType: string
  language: string
}

export type GenerateTrackFragmentResponse = {
  path: string
}

export function useTrackAudioFragmentGenerator(
  options: TrackFragmentGenerationOptions
) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const toTime = useTimeFormatter().fromSeconds
  const store = useTrackAudioFragmentStore()

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Generates fragment Id
   * @param request Request to generate Id
   * @returns String
   */
  async function getFragmentId(
    request: GenerateTrackFragmentIdRequest 
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
    const audioType = (
      request.audioType !== 'original' ? `(${request.audioType})` : ''
    )

    return `${authorName} – ${trackTitle} ${timeRange} ${audioType}.mp3`
      .replace(/[<>"\/\\|?*\x00-\x1F]/g, '_') // Replace invalid filename characters
      .replace(/\s+/g, ' ')                    // Normalize whitespace
      .trim()
  }


  /**
   * Generate track audio fragment
   * @param request Request to generate track fragment
   * @returns Path where generated file was saved
   */
  async function generate(
    request: GenerateTrackFragmentRequest
  ): Promise<GenerateTrackFragmentResponse> {
    try {
      store.busy = true
      const payload: AudioSegmentRequest = {
        filePath: request.filePath,
        timeStart: request.timeStart,
        timeEnd: request.timeEnd,
      }
      
      // make request to the service to generate fragment
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

      // download track fragment
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

  return { getFragmentId, generate }
}