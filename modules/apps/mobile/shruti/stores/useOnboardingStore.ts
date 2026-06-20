import { defineStore } from "pinia"
import { ref } from "vue"
import { useShruti } from "@shruti/shruti.js"

/** Persisted in preferences so a reinstall replays onboarding — the expected
 *  first-launch behaviour. Read once at startup to choose the initial route. */
export const ONBOARDING_COMPLETED_KEY = "onboarding.completed"

/** Topic ids the user picked during onboarding. Stored separately from the
 *  search-filter selection so the daily-wisdom rule samples from the user's
 *  declared interests even if they later change their library filters. */
export const ONBOARDING_INTERESTS_KEY = "onboarding.interestTopicIds"

/**
 * Tracks whether the first-launch onboarding has been completed (or skipped).
 * The flag is only set at the very end of the flow, so an interrupted
 * onboarding replays from the start on the next launch.
 */
export const useOnboardingStore = defineStore("onboarding", () => {
  const app = useShruti()

  const completed = ref<boolean>(false)
  const loaded = ref<boolean>(false)

  async function load(): Promise<void> {
    if (loaded.value) return
    completed.value = (await app.preferences.get(ONBOARDING_COMPLETED_KEY)) === "true"
    loaded.value = true
  }

  async function markCompleted(): Promise<void> {
    completed.value = true
    await app.preferences.set(ONBOARDING_COMPLETED_KEY, "true")
  }

  async function reset(): Promise<void> {
    completed.value = false
    await app.preferences.set(ONBOARDING_COMPLETED_KEY, "false")
  }

  return { completed, loaded, load, markCompleted, reset }
})

/** Read the completed flag without Pinia — used by startup routing before the
 *  app (and an active pinia) is mounted. */
export async function readOnboardingCompleted(
  preferences: { get(key: string): Promise<string | null> }
): Promise<boolean> {
  return (await preferences.get(ONBOARDING_COMPLETED_KEY)) === "true"
}
