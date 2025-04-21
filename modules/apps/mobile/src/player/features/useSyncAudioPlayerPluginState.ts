import { usePlayer, usePlayerControls } from '@/player'

/**
 * Syncs the player controls with the Audio Player plugin state.
 */
export function useSyncAudioPlayerPluginState() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const playerControls = usePlayerControls()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  player.onProgressChanged(async (progress) => {
    if (!progress.trackId) { return }
    
    // Track has changed, update the title and author
    if (progress.trackId !== playerControls.trackId.value) {
      playerControls.trackId.value = progress.trackId
    }

    // Update the rest of the player controls
    playerControls.isPlaying.value = progress.playing
    playerControls.position.value = progress.position
  })
}