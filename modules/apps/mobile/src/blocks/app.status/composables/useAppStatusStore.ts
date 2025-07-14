import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ServerStatus = {
  name: string
  url: string
  description: string
  status: 'online' | 'offline' | 'unknown'
}

export const useAppStatusStore = defineStore('appStatus', () =>{

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const serverStatuses = ref<ServerStatus[]>([])

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function setServerStatus(
    server: string, 
    status: 'online' | 'offline' | 'unknown'
  ) {
    const serverStatus = serverStatuses.value.find(s => s.name === server)
    if (serverStatus) {
      serverStatus.status = status
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { serverStatuses, setServerStatus }
})