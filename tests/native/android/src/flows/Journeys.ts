import type { OnboardingScreen } from "../screens/OnboardingScreen.js"
import type { PlayerBar } from "../screens/PlayerBar.js"
import type { QueueScreen } from "../screens/QueueScreen.js"
import type { SearchScreen } from "../screens/SearchScreen.js"
import type { TabBar } from "../screens/TabBar.js"
import type { AppTheme } from "../screens/AppTheme.js"
import type { TrackSheet } from "../screens/TrackSheet.js"

export interface JourneyScreens {
  readonly onboarding: OnboardingScreen
  readonly tabs: TabBar
  readonly search: SearchScreen
  readonly sheet: TrackSheet
  readonly queue: QueueScreen
  readonly player: PlayerBar
  readonly theme: AppTheme
}

/** User-level scenarios the specs compose; no selectors live here. */
export class Journeys {
  constructor(private readonly screens: JourneyScreens) {}

  async startFresh(): Promise<void> {
    await this.screens.onboarding.skip()
    await this.screens.tabs.waitUntilVisible()
  }

  async queueFirstTrack(): Promise<string> {
    await this.screens.tabs.go("search")
    const title = await this.screens.search.openFirstTrack()
    await this.screens.sheet.addToQueue()
    return title
  }

  async playFirstQueued(): Promise<void> {
    await this.screens.tabs.go("home")
    await this.screens.queue.playFirst()
    await this.screens.player.waitUntilVisible()
  }

  async playFirstTrack(): Promise<string> {
    const title = await this.queueFirstTrack()
    await this.playFirstQueued()
    return title
  }

  async reopenAfterRestart(): Promise<void> {
    await this.screens.tabs.waitUntilVisible()
  }
}
