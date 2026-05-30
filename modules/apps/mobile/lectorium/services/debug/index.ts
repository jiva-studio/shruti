/**
 * Debug bridge installed only when `VITE_DEBUG_API=true`. Exposed at
 * `window.__lectorium.debug`. Production builds tree-shake it via the
 * `import.meta.env.VITE_DEBUG_API` guard in `main.ts`.
 *
 * Used by `modules/tools/screenshots` to drive the app into known
 * states (open transcript over a known track + mid-playback position)
 * without re-implementing user gestures.
 */
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useChatStore } from "@lectorium/stores/useChatStore.js"
import { useTranscriptStore } from "@lectorium/stores/useTranscriptStore.js"
import { currentLocale, setLocale, type SupportedLocale } from "@lectorium/i18n/index.js"
import router from "@lectorium/router/index.js"
import type { TrackId, LanguageCode } from "@lib/domain/core.js"

const DEMO_TRACKS: Record<SupportedLocale, string> = {
  en: "track_0M6TgFqYKo01",
  ru: "track_95Z39JrFM1MQ",
}

/**
 * Position (ms) that lands inside a real transcript block for each demo
 * track. The values are eyeballed from the canonical transcript JSON
 * (resources/lake-out/public/tracks/<id>/transcripts/<lang>.json) and
 * picked so the `.current` highlight sits on a *different* sentence than
 * any seeded note — the screenshot shows both states simultaneously.
 */
const DEMO_POSITIONS_MS: Record<SupportedLocale, number> = {
  // Inside the FIRST visible block of each demo transcript so the
  // dialog opens with paragraph #1 already lit as `.current`. Tracked
  // back to `resources/lake-out/public/tracks/<id>/transcripts/<lc>.json`
  // — see the verse:translation block at 10840–16260 for EN, the
  // intro sentence at 480–14560 for RU.
  en: 13_000,
  ru: 5_000,
}

declare global {
  interface Window {
    __lectorium?: {
      debug?: LectoriumDebugApi
    }
  }
}

interface LectoriumDebugApi {
  demoTrackId(): string
  demoPositionMs(): number
  navigateTo(path: string): Promise<void>
  openChatSession(sessionId: string): Promise<void>
  openTranscript(trackId: string): Promise<void>
  setPlayerState(trackId: string, positionMs: number): Promise<void>
  setLocale(loc: SupportedLocale): void
}

export function installDebugApi(): void {
  const api: LectoriumDebugApi = {
    demoTrackId(): string {
      return DEMO_TRACKS[currentLocale()] ?? DEMO_TRACKS.en
    },

    demoPositionMs(): number {
      return DEMO_POSITIONS_MS[currentLocale()] ?? DEMO_POSITIONS_MS.en
    },

    async navigateTo(path: string): Promise<void> {
      await router.push(path)
    },

    // Open a chat session deterministically. ChatView normally opens the
    // session reactively from `?session=<id>` (ensureSessionFromRoute),
    // but `useRoute()` inside that controller is flaky under the Vite-dev
    // DI race (see ChatView.controller.ts) — in the dev-served screenshots
    // build the query watcher never fires, so the deep link silently
    // no-ops. Drive the store directly (the same `openSession` that
    // `onPickSession` calls) and sync the URL so the captured frame
    // matches a real shared-link/recent-tap open.
    async openChatSession(sessionId: string): Promise<void> {
      await useChatStore().openSession(sessionId)
      await router.replace({ name: "chat", query: { session: sessionId } })
    },

    async openTranscript(trackId: string): Promise<void> {
      useTranscriptStore().show(trackId as TrackId)
    },

    async setPlayerState(trackId: string, positionMs: number): Promise<void> {
      const lectorium = useLectorium()
      const repos = lectorium.repositories()
      const track = await repos.tracks.getById(trackId as TrackId)
      if (!track) throw new Error(`debug.setPlayerState: track not found ${trackId}`)

      const lang = (track.variants[0]?.language ?? "en") as LanguageCode
      const variant = track.variants.find((v) => v.language === lang) ?? track.variants[0]
      if (!variant) throw new Error(`debug.setPlayerState: no variants for ${trackId}`)

      let authorName = ""
      try {
        const author = track.authorId ? await repos.authors.getById(track.authorId) : null
        authorName = author?.names.get(lang) ?? author?.names.values().next().value ?? ""
      } catch {
        // best-effort; an empty name still produces a usable screenshot
      }

      const player = usePlayerStore()
      player.trackId = trackId as TrackId
      player.title = variant.title
      player.authorName = authorName
      player.language = lang
      player.playing = true
      player.positionMs = positionMs
      player.durationMs = variant.audio?.duration ?? 0
    },

    setLocale(loc: SupportedLocale): void {
      setLocale(loc)
    },
  }

  ;(window as Window).__lectorium = (window as Window).__lectorium ?? {}
  ;(window as Window).__lectorium!.debug = api
  console.info("[debug] window.__lectorium.debug installed")
}
