import { defineStore } from 'pinia'
import { reactive } from 'vue'

export type TrackStatus = {
  inPlaylist: boolean,       // if the track is added to the playlist
  downloadProgress?: number, // downloading loading progress of the track
  downloadFailed?: boolean,  // if the download failed
  completed?: boolean,       // if the track is played fully
}

const defaultTrackStatus: TrackStatus = {
  inPlaylist: false,
}

export const useTrackStateStore = defineStore('trackState', () =>{
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const statuses = reactive<Record<string, TrackStatus>>({}) 

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function getStatus(trackId: string): TrackStatus {
    if (!statuses[trackId]) {
      return { inPlaylist: false }
    }
    return statuses[trackId]
  }

  function setStatus(
    trackId: string, 
    status: Partial<TrackStatus>
  ) {
    statuses[trackId] = { 
      ...statuses[trackId] || defaultTrackStatus, 
      ...status 
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Getters                                  */
  /* -------------------------------------------------------------------------- */

  function isInPlaylist(trackId: string) {
    return getStatus(trackId).inPlaylist === true
  }

  function isCompleted(trackId: string) {
    return getStatus(trackId).completed === true
  }

  function isDownloading(trackId: string) {
    const progress = getStatus(trackId).downloadProgress
    return progress !== undefined && progress < 100
  }

  function downloadProgress(trackId: string) {
    return getStatus(trackId).downloadProgress 
  }

  function downloadFailed(trackId: string) {
    return getStatus(trackId).downloadFailed === true
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { 
    statuses, getStatus, setStatus, isInPlaylist, 
    isCompleted, isDownloading, downloadProgress,
    downloadFailed 
  }
})

