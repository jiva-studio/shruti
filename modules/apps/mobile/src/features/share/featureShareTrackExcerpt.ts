import { Share } from '@capacitor/share'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Clipboard } from '@capacitor/clipboard'
import { useEventBus, useLogger } from '@lectorium/mobile/core'
import { Routes } from '@lectorium/protocol/routes'
import { useTrackAudioFragmentGenerator } from '@blocks/app.share.track.audio.fragment'
import { useTrackTextExcerptFormatter } from '@blocks/app.share.track.text.formatter'
import { useConfig } from '@blocks/app.config'
import { useDAL } from '@blocks/app.database'

export function featureShareTrackExcerpt() {

  const directoryName = 'track-fragments'

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const config = useConfig()
  const logger = useLogger({ module: 'share.track.fragment' })
  const eventBus = useEventBus()
  const audioFragmentGenerator =  
    useTrackAudioFragmentGenerator({
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

    // try to get audio fragments
    if (event.timeStart && event.timeEnd && event.shareAudio) {
      try {
        const track = await dal.tracks.getOne(event.trackId)
        const filePath = track.audio[event.audioType]?.path
        if (!filePath) { throw new Error('No audio file found') }

        const file = await getFile(
          event.trackId,
          filePath,
          event.audioType,
          config.appLanguage.value,
          event.timeStart,
          event.timeEnd,
          config.authToken.value
        )
        files = file ? [file] : undefined
      } catch (err: any) { 
        logger.error('Unable to get audio fragment to share', err)
      }
    }

    // share using system dialog
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

  async function getFile(
    trackId: string,
    filePath: string,
    audioType: string,
    language: string,
    timeStart: number,
    timeEnd: number,
    authToken: string,
  ): Promise<string | undefined> {
    // generate fragment Id based on track information
    const fragmentId = await audioFragmentGenerator.getFragmentId({
      trackId: trackId,
      timeStart: timeStart,
      timeEnd: timeEnd,
      audioType: audioType,
      language: language 
    })
    const trackFragmentPath = `${directoryName}/${fragmentId}`

    // check if file is already downloaded
    try {
      const fileStat = await Filesystem.stat({ 
        path: trackFragmentPath,
        directory: Directory.Cache
      })
      return fileStat.uri
    } catch { /* do nothing */ }

    // create required folder
    try {
      await Filesystem.mkdir({
        path: directoryName,
        directory: Directory.Cache,
        recursive: true
      })
    } catch (err: any) {
      if (err.code === 'OS-PLUG-FILE-0010') { /* ignore it */ }
      else throw err
    }

    // call generator
    const generatedFragment = await audioFragmentGenerator
      .generate({
        filePath: filePath,
        outputPath: trackFragmentPath,
        timeStart: timeStart,
        timeEnd: timeEnd,
        authToken: authToken,
      })
    return 'file://' + generatedFragment.path
  }
}