import { watch } from 'vue'
import { useEventBus } from '@lectorium/mobile/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { useTracksState } from '@blocks/app.tracks.state'
import { usePlayer } from '@blocks/app.player'
import { usePlayerStore } from '@blocks/app.player.state'
import { useTranscriptStore } from '@blocks/app.transcript'
import { useDAL } from '@blocks/app.database'
import { useConfig } from '@blocks/app.config'
import { usePlaylistStore } from '@blocks/app.playlist'


export function setupPlayerFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const player = usePlayer()
  const config = useConfig()
  const eventBus = useEventBus()
  const tracksState = useTracksState()
  const playerStore = usePlayerStore()
  const playlistStore = usePlaylistStore()
  const transcriptStore = useTranscriptStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  /* ---------------------------- Play Track Event ---------------------------- */

  eventBus.trackPlay.subscribe(async (event) => {
    // Notify user
    await Haptics.impact({ style: ImpactStyle.Light })
    if (playerStore.playlistItemId === event.playlistItemId) { return }
    
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
      itemId: playlistItem._id,
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
    const playlistItemState = playlistStore.getState(playlistItem._id)
    if (playlistItemState.progress && playlistItemState.progress !== 100) {
      await player.seek.call(track.audio.original.duration * playlistItemState.progress / 100)
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
    if (!status.itemId) { return }
    if (status.itemId !== playerStore.playlistItemId) {
      setInfo(status.itemId, config.appLanguage.value)
      playerStore.playlistItemId = status.itemId
    }
    playerStore.position = status.position
    playerStore.duration = status.duration
    playerStore.isPlaying = status.playing
  })

  watch(config.appLanguage, async (value) => {
    await setInfo(playerStore.playlistItemId, value)
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function setInfo(
    playlistItemId: string, 
    language: string
  ) {
    if (!playlistItemId) { return }
    if (!language) { return }

    const playlistItem = await dal.playlistItems.getOne(playlistItemId)
    const track = await dal.tracks.getOne(playlistItem.trackId)
    const author = await dal.authors.getOne('author::' + track.author)

    playerStore.trackId = playlistItem.trackId
    playerStore.title =
      track.title[config.appLanguage.value]
        || track.title['en']
        || track.title[Object.keys(track.title)[0]]
        || 'No title'
    playerStore.author =
      author.fullName[config.appLanguage.value]
        || author.fullName['en']
        || author.fullName[Object.keys(author.fullName)[0]]
        || track.author
  }
}