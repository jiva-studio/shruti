import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useTutorialStore = defineStore('tutorial', () =>{

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const completedSteps = ref<string[]>([])
  
  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function completeStep(step: string) {
    if (completedSteps.value.includes(step)) { return }
    completedSteps.value.push(step)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { completeStep, completedSteps }
})
