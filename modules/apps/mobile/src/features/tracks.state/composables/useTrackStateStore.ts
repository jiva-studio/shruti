import { ref } from 'vue'
import { defineStore } from 'pinia'

export type TrackState = {
  inPlaylist?: boolean
  isCompleted?: boolean
  isFailed?: boolean
  downloadProgress?: number
  downloadFailed?: boolean
}

export const useTrackStateStore = defineStore('trackState', () => {
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const statuses = ref<Record<string, TrackState>>({})

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function setState(
    trackId: string, 
    status: Partial<TrackState>
  ) {
    if (!statuses.value[trackId]) {
      statuses.value[trackId] = {}
    }
    statuses.value[trackId] = {
      ...statuses.value[trackId],
      ...status
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Getters                                  */
  /* -------------------------------------------------------------------------- */

  function getState(trackId: string): TrackState {
    return statuses.value[trackId] || {}
  }

  return {
    statuses, getState, setState
  }
})