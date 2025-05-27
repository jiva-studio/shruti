import { usePlayer, usePlayerControls } from '@lectorium/mobile/features/player'

export function usePlayerControlsPlayerScenario() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const player = usePlayer()
  const playerControls = usePlayerControls()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function togglePause() {
    await player.togglePause()
    playerControls.isPlaying.value = !playerControls.isPlaying.value
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    togglePause
  }
}