import type { OnboardingScreen, WisdomPreset } from "../screens/OnboardingScreen.js"
import type { PlayerBar } from "../screens/PlayerBar.js"
import type { QueueScreen } from "../screens/QueueScreen.js"
import type { SearchScreen } from "../screens/SearchScreen.js"
import type { SettingsScreen } from "../screens/SettingsScreen.js"
import type { TabBar } from "../screens/TabBar.js"
import type { ActivityCard } from "../screens/ActivityCard.js"
import type { AppTheme } from "../screens/AppTheme.js"
import type { AppLanguage } from "../screens/AppLanguage.js"
import type { SafeArea } from "../screens/SafeArea.js"
import type { ShareMenu } from "../screens/ShareMenu.js"
import type { TrackSheet } from "../screens/TrackSheet.js"

export interface JourneyScreens {
  readonly onboarding: OnboardingScreen
  readonly tabs: TabBar
  readonly search: SearchScreen
  readonly sheet: TrackSheet
  readonly shareMenu: ShareMenu
  readonly queue: QueueScreen
  readonly player: PlayerBar
  readonly theme: AppTheme
  readonly appLanguage: AppLanguage
  readonly safeArea: SafeArea
  readonly settings: SettingsScreen
  readonly activity: ActivityCard
}

/** User-level scenarios the specs compose; no selectors live here. */
export class Journeys {
  constructor(private readonly screens: JourneyScreens) {}

  async startFresh(): Promise<void> {
    await this.screens.onboarding.skip()
    await this.screens.tabs.waitUntilVisible()
  }

  /** Onboarding taken the other way: the daily reminder switched on, which is
   *  what hands the OS a schedule. */
  async startWithDailyWisdom(preset: WisdomPreset = "morning"): Promise<void> {
    await this.screens.onboarding.chooseDailyWisdom(preset)
    await this.screens.onboarding.finish()
    await this.screens.tabs.waitUntilVisible()
  }

  async queueFirstTrack(): Promise<string> {
    return this.queueTrackAt(0)
  }

  async queueTrackAt(index: number): Promise<string> {
    await this.screens.tabs.go("search")
    const title = await this.screens.search.openTrackAt(index)
    await this.screens.sheet.addToQueue()
    return title
  }

  /** Hand a lecture's link to the OS: the track sheet, its share menu, and the
   *  one format that needs no transcript and no downloaded audio. */
  async shareFirstTrackLink(): Promise<void> {
    await this.screens.tabs.go("search")
    await this.screens.search.openFirstTrack()
    await this.screens.sheet.share()
    await this.screens.shareMenu.shareLink()
  }

  /** Hand a lecture's audio to the OS: the format that shares a file off the disk. */
  async shareFirstTrackAudio(): Promise<void> {
    await this.screens.tabs.go("search")
    await this.screens.search.openFirstTrack()
    await this.screens.sheet.share()
    await this.screens.shareMenu.shareAudio()
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

  /** Ionic keeps Home mounted, so its activity numbers reload on view-enter only. */
  async revisitHome(): Promise<void> {
    await this.screens.tabs.go("search")
    await this.screens.tabs.go("home")
  }
}
