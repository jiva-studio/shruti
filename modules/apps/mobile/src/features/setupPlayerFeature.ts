import { watch } from 'vue'
import { useEventBus } from '@lectorium/mobile/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { useTracksState } from '@blocks/app.tracks.state'
import { usePlayer } from '@blocks/app.player'
import { useTranscriptStore } from '@blocks/app.transcript'
import { useDAL } from '@blocks/app.database'
import { useConfig } from '@blocks/app.config'


export function setupPlayerFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const player = usePlayer()
  const config = useConfig()
  const eventBus = useEventBus()
  const tracksState = useTracksState()
  const transcriptStore = useTranscriptStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  /* ---------------------------- Play Track Event ---------------------------- */

  eventBus.trackPlay.subscribe(async (event) => {
    // Notify user
    await Haptics.impact({ style: ImpactStyle.Light })
    
    const playlistItem = await dal.playlistItems.getOne(event.playlistItemId)
    const track = await dal.tracks.getOne(playlistItem.trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    // Start downloading track if it is not downloaded yet
    const trackState = tracksState.store.getState(playlistItem.trackId)
    if (trackState.isFailed) {
      // Track is in failed state, start download again
      eventBus.trackDownload.notify({ 
        trackIds: [track._id], 
        skipFailed: false,
        showError: true,
      })
      return
    }
    if (trackState.downloadProgress !== undefined && trackState.downloadProgress < 100) {
      // Track is being downloaded, do not play it
      return
    }

    // Open track with Audio Player plugin and
    // pass required information for media session widget
    const r = await Filesystem.getUri({
      path: track.audio.original.path,
      directory: Directory.External,
    })

    await player.open({
      trackId: track._id,
      playlistItemId: playlistItem._id,
      url: r.uri, 
      title: track.title[config.appLanguage.value]
        || track.title['en']
        || track.title[Object.keys(track.title)[0]]
        || 'No title',
      author: author.fullName[config.appLanguage.value] 
        || author.fullName['en'] 
        || author.fullName[Object.keys(author.fullName)[0]]
        || track.author
        || 'Unknown author',
    })
    await eventBus.transcriptLoad.notify({ trackId: track._id })

    // Start playing the track
    await player.play.call()

    // Set playback progress if it exists
    if (trackState.playbackProgress) {
      await player.seek.call(track.audio.original.duration * trackState.playbackProgress / 100)
    }

    // Open transcript if it is enabled in the config
    if (config.openTranscriptAutomatically.value) {
      transcriptStore.open = true
      if (!config.tutorialStepsCompleted.value.includes('transcript:open')) {
        config.tutorialStepsCompleted.value.push('transcript:open')
      }
    }
  })

  /* ------------------------------- Player Seek ------------------------------ */

  eventBus.playerSeek.subscribe(async (position) => {
    await player.seek.call(position)
  })

  eventBus.playerTogglePause.subscribe(async () => {
    await player.togglePause.call()
  })

  /* -------------------------- Playlist Update Event ------------------------- */

  player.progress.subscribe(async (status) => {
    if (!status.trackId) { return }
    if (player.title.value && player.title.value) { return }
    setInfo(status.trackId, config.appLanguage.value)
  })

  watch(config.appLanguage, async (value) => {
    await setInfo(player.trackId.value, value)
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function setInfo(
    trackId: string, 
    language: string
  ) {
    if (!trackId) { return }
    if (!language) { return }

    const track = await dal.tracks.getOne(trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    player.title.value =
      track.title[config.appLanguage.value]
        || track.title['en']
        || track.title[Object.keys(track.title)[0]]
        || 'No title'
    player.author.value =
      author.fullName[config.appLanguage.value]
        || author.fullName['en']
        || author.fullName[Object.keys(author.fullName)[0]]
        || track.author
  }
}