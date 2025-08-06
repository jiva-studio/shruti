import { Share } from '@capacitor/share'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Clipboard } from '@capacitor/clipboard'
import { useEventBus } from '@shruti/mobile/core'
import { Routes } from '@shruti/protocol/routes'
import { useTrackAudioExcerptGenerator } from '@blocks/app.share.track.audio.excerpt'
import { useTrackTextExcerptFormatter } from '@blocks/app.share.track.text.formatter'
import { useConfig } from '@blocks/app.config'
import { useDAL } from '@blocks/app.database'

export function featureShareTrackExcerpt() {

  const directoryName = 'track-excerpts'

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const eventBus = useEventBus()
  const audioExcerptGenerator =  
    useTrackAudioExcerptGenerator({
      url: Routes(config.apiUrl.value).audio.segment(),
      tracksRepository: dal.tracks,
      authorsRepository: dal.authors,
    })
  const textFormatter = useTrackTextExcerptFormatter({ tracksRepository: dal.tracks })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.shareSendTrackExcerpt.subscribe(async (event) => {
    if (!event.text && (!event.timeStart || !event.timeEnd)) {
      throw new Error('Either text or both timeStart and timeEnd must be provided')
    }
    let files: string[] | undefined = undefined

    // try to get audio excerpts
    if (event.timeStart && event.timeEnd && event.shareAudio) {
      try {
        files = await getFiles(
          event.trackId,
          config.appLanguage.value,
          event.timeStart,
          event.timeEnd,
          config.authToken.value
        )
      } catch { /* Do nothing */ }
    }

    // share uding system dialog
    try {
      await Share.share({
        text: event.text 
          ? await getText(
              event.trackId, config.appLanguage.value, 
              event.text, event.timeStart,
              event.timeEnd
            ) : undefined,
        files: files,
      })
    } catch (err: any) {
      if (err.message === 'Share canceled') { /* ignore it */ }
      else throw err
    }
  })


  eventBus.shareCopyTrackExcerpt.subscribe(async (event) => {
    const text = await getText(event.trackId, config.appLanguage.value, event.text)
    await Clipboard.write({ string: text })
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Helpers¸                                  */
  /* -------------------------------------------------------------------------- */

  async function getText(
    trackId: string,
    language: string,
    text: string,
    timeStart?: number,
    timeEnd?: number,
  ): Promise<string | undefined> {
    return await textFormatter.format({
      trackId: trackId,
      language: language,
      timeStart: timeStart,
      timeEnd: timeEnd,
      text: text,
    })
  }

  async function getFiles(
    trackId: string,
    language: string,
    timeStart: number,
    timeEnd: number,
    authToken: string,
  ): Promise<string[] | undefined> {
    // generate excerpt Id based on track information
    const excerptId = await audioExcerptGenerator.getExcerptId({
      trackId: trackId,
      timeStart: timeStart,
      timeEnd: timeEnd,
      audioType: 'original',
      language: language 
    })
    const trackExceprtPath = `${directoryName}/${excerptId}`

    // check if file is already downloaded
    try {
      const fileStat = await Filesystem.stat({ 
        path: trackExceprtPath,
        directory: Directory.Cache
      })
      return [fileStat.uri]
    } catch { /* do nothing */ }

    // create requried folder
    try {
      await Filesystem.mkdir({
        path: directoryName,
        directory: Directory.Cache,
        recursive: true
      })
    } catch (err: any) {
      if (err.message === 'Directory exists') { /* ignore it */ }
      else throw err
    }

    // call generator
    const generatedExcerpt = await audioExcerptGenerator
      .generate({
        authToken: authToken,
        trackId: trackId,
        timeStart: timeStart,
        timeEnd: timeEnd,
        audioType: 'original',
        outputPath: trackExceprtPath,
      })

    return ['file://' + generatedExcerpt.path]
  }
}