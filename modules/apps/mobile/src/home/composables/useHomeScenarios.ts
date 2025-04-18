import { createGlobalState } from '@vueuse/core'
import { useDAL } from '@/app'
import { UserSeesUpNextTracksScenario } from '../scenarios/UserSeesUpNextTracksScenario'

export const useHomeScenarios = createGlobalState(() => {
  const dal = useDAL()

  return {
    userSeesUpNextTracksScenario: 
      new UserSeesUpNextTracksScenario(dal.playlistItems, dal.mediaItems, dal.tracks),
  }
})