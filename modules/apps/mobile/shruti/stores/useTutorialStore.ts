import { defineStore } from "pinia"
import { ref } from "vue"
import { useShruti } from "@shruti/shruti.js"

interface SeenFlags {
  home: boolean
  search: boolean
  player: boolean
}

const STORAGE_KEY = "tutorial.v1"
const DEFAULT: SeenFlags = { home: false, search: false, player: false }

/**
 * Persisted "seen this onboarding step" flags. Lives in preferences so a
 * reinstall resets the tutorial, which is the behaviour users expect.
 * The store exposes each flag individually so banners can v-if on them
 * without knowing about the payload shape.
 */
export const useTutorialStore = defineStore("tutorial", () => {
  const app = useShruti()

  const flags = ref<SeenFlags>({ ...DEFAULT })
  const loaded = ref<boolean>(false)

  async function load(): Promise<void> {
    if (loaded.value) return
    const raw = await app.preferences.get(STORAGE_KEY)
    if (raw) {
      try {
        flags.value = { ...DEFAULT, ...(JSON.parse(raw) as Partial<SeenFlags>) }
      } catch {
        // Ignore corrupt payload; keep defaults.
      }
    }
    loaded.value = true
  }

  async function dismiss(step: keyof SeenFlags): Promise<void> {
    flags.value = { ...flags.value, [step]: true }
    await app.preferences.set(STORAGE_KEY, JSON.stringify(flags.value))
  }

  async function reset(): Promise<void> {
    flags.value = { ...DEFAULT }
    await app.preferences.set(STORAGE_KEY, JSON.stringify(flags.value))
  }

  return { flags, loaded, load, dismiss, reset }
})
